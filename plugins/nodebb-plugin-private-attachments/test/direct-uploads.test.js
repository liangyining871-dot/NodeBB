'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDirectUploads } = require('../direct-uploads');
const { readDirectConfig, createMultipartStorage } = require('../multipart-storage');
const { Client } = require('minio');
const { patchSource } = require('../../../scripts/patch-composer');

const MiB = 1024 * 1024;
function fixture() {
	const records = new Map();
	const sets = new Map();
	const expiry = new Map();
	let clock = 1000;
	const db = {
		async getObject(key) { const value = records.get(key); return value ? { ...value } : null; },
		async setObject(key, value) { records.set(key, { ...records.get(key), ...value }); },
		async setObjectField(key, field, value) { records.get(key)[field] = value; },
		async getSetMembers(key) { return [...(sets.get(key) || [])]; },
		async setAdd(key, value) { if (!sets.has(key)) { sets.set(key, new Set()); } sets.get(key).add(value); },
		async setRemove(key, value) { sets.get(key)?.delete(value); },
		async sortedSetAdd(key, score, value) { expiry.set(value, score); },
		async sortedSetRemove(key, value) { expiry.delete(value); },
		async getSortedSetRangeByScore(key, start, count, min, max) { return [...expiry].filter(([, score]) => score <= max).map(([id]) => id).slice(start, start + count); },
		async delete(key) { records.delete(key); },
	};
	let permitted = true;
	let valid = true;
	let exists = false;
	const calls = [];
	let uploaded = [];
	let fileSize = 11 * MiB;
	const storage = {
		async create(key) { calls.push(['create', key]); return 'minio-upload-id'; },
		async sign(key, uploadId, part) { return `https://storage.test/private/${key}?uploadId=${uploadId}&partNumber=${part}`; },
		async parts() { return uploaded; },
		async complete() { calls.push(['complete']); exists = true; },
		async stat() { if (!exists) { throw Object.assign(new Error('missing'), { code: 'NoSuchKey' }); } return { size: fileSize, etag: 'multipart-etag' }; },
		async prefix() { return Buffer.from('video'); },
		async abort(key) { calls.push(['abort', key]); },
		async remove(key) { calls.push(['remove', key]); exists = false; },
	};
	const config = { ...readDirectConfig({ MINIO_DIRECT_UPLOAD_ENABLED: 'true', MINIO_PUBLIC_URL: 'https://storage.test' }), partSize: 5 * MiB };
	const service = createDirectUploads({ db, config, storage, now: () => clock,
		privileges: { global: { async can() { return permitted; } } },
		async detectBuffer() { return valid ? { mime: 'video/mp4', ext: 'mp4' } : { mime: 'text/html', ext: 'html' }; },
		allowedExtensions: () => ['.mp4'], blockedExtensions: () => ['.html'], relativePath: '/forum' });
	return { service, db, records, config, storage, calls,
		set permitted(value) { permitted = value; }, set valid(value) { valid = value; },
		set parts(value) { uploaded = value; }, set size(value) { fileSize = value; },
		expire() { clock += config.taskTTL + 1; },
		async create(size = 11 * MiB) {
			fileSize = size;
			const task = await service.create(12, { name: '视频.mp4', size });
			uploaded = Array.from({ length: task.partCount }, (_, index) => ({ part: index + 1,
				size: Math.min(config.partSize, size - index * config.partSize), etag: `etag-${index}` }));
			return task;
		} };
}

test('直传配置默认关闭，限制 2GiB，公网地址不允许路径或凭据', () => {
	assert.equal(readDirectConfig({}).enabled, false);
	for (const url of ['http://user:pass@storage.test', 'ftp://storage.test', 'https://storage.test/s3', 'bad']) {
		assert.throws(() => readDirectConfig({ MINIO_DIRECT_UPLOAD_ENABLED: 'true', MINIO_PUBLIC_URL: url }));
	}
	assert.throws(() => readDirectConfig({ MINIO_DIRECT_UPLOAD_MAX_BYTES: String(2147483649) }));
});

test('创建鉴权、大小边界及用户任务配额，不能指定对象路径', async () => {
	const f = fixture();
	await assert.rejects(f.service.create(0, { name: 'v.mp4', size: 5 }), { status: 403 });
	await assert.rejects(f.service.create(12, { name: 'v.mp4', size: 2147483649 }), { status: 413 });
	await assert.rejects(f.service.create(12, { name: 'v.html', size: 5 }), { status: 400 });
	const boundary = await f.create(2147483648);
	assert.equal(boundary.partCount, Math.ceil(2147483648 / f.config.partSize));
	assert.equal(f.records.has(`privateAttachment:${boundary.id}`), false);
	await f.create(); await f.create();
	await assert.rejects(f.create(), { status: 429 });
	await f.service.cancel(12, boundary.id);
	await f.create();
});

test('签名绑定上传者、任务、有效分片编号，接口不接受对象键', async () => {
	const f = fixture();
	const task = await f.create();
	await assert.rejects(f.service.sign(13, task.id, 1), { status: 404 });
	for (const part of [0, -1, 4, 1.5, 'bad']) { await assert.rejects(f.service.sign(12, task.id, part), { status: 400 }); }
	assert.match((await f.service.sign(12, task.id, 2)).url, new RegExp(`${task.id}/original.mp4.*partNumber=2`));
	f.permitted = false;
	await assert.rejects(f.service.complete(12, task.id), { status: 403 });
});

test('缺失、超大或错误编号分片拒绝合并；类型伪装不登记且删除对象', async () => {
	const f = fixture();
	const task = await f.create();
	f.parts = [{ part: 1, size: 11 * MiB, etag: 'bad' }];
	await assert.rejects(f.service.complete(12, task.id), { status: 400 });
	assert.equal(f.calls.some(call => call[0] === 'complete'), false);
	await f.service.cancel(12, task.id);
	const fake = await f.create();
	f.valid = false;
	await assert.rejects(f.service.complete(12, fake.id), { status: 400 });
	assert.equal(f.records.has(`privateAttachment:${fake.id}`), false);
	assert.ok(f.calls.some(call => call[0] === 'remove'));
});

test('完成并发请求只合并一次，登记原有附件格式，已关联记录不被重试覆盖', async () => {
	const f = fixture();
	const task = await f.create();
	const [a, b] = await Promise.all([f.service.complete(12, task.id), f.service.complete(12, task.id)]);
	assert.deepEqual(a, b);
	assert.ok(a.url.startsWith(`/forum/attachments/${task.id}/original/`));
	assert.equal(f.calls.filter(call => call[0] === 'complete').length, 1);
	const record = f.records.get(`privateAttachment:${task.id}`);
	assert.equal(record.status, 'pending');
	assert.equal(record.objectETag, 'multipart-etag');
	record.status = 'attached'; record.pid = 10;
	await f.service.cancel(12, task.id);
	await f.service.complete(12, task.id);
	assert.equal(record.status, 'attached');
	f.expire(); await f.service.cleanup();
	assert.equal(f.records.get(`privateAttachment:${task.id}`).pid, 10);
});

test('完成响应丢失或落库失败可重试；取消不删除已登记附件', async () => {
	const f = fixture();
	const task = await f.create();
	const complete = f.storage.complete;
	f.storage.complete = async (...args) => { await complete(...args); throw new Error('connection lost'); };
	await assert.rejects(f.service.complete(12, task.id), /connection lost/);
	await f.service.complete(12, task.id);
	await f.db.setObjectField(`privateMultipart:${task.id}`, 'state', 'completing');
	await f.service.cancel(12, task.id);
	assert.ok(f.records.has(`privateAttachment:${task.id}`));
	assert.equal(f.calls.filter(call => call[0] === 'complete').length, 1);
});

test('过期任务不可签名，清理真实中断上传并释放用户配额', async () => {
	const f = fixture();
	const task = await f.create();
	f.expire();
	await assert.rejects(f.service.sign(12, task.id, 1), { status: 410 });
	await f.service.cleanup();
	assert.equal(f.records.has(`privateMultipart:${task.id}`), false);
	assert.ok(f.calls.some(call => call[0] === 'abort'));
	assert.deepEqual(await f.db.getSetMembers('privateMultipart:user:12'), []);
});

test('公网签名使用浏览器域名和内部获取的区域，不访问公网获取区域', async (t) => {
	t.mock.method(Client.prototype, 'presignedUrl', async function (method, bucket, key, expires, query) {
		assert.equal(this.host, 'upload.test');
		assert.equal(this.region, 'cn-test-1');
		assert.equal(query.partNumber, 1);
		return 'https://upload.test/signed';
	});
	const env = { MINIO_ENDPOINT: 'internal', MINIO_ACCESS_KEY: 'test', MINIO_SECRET_KEY: 'secret' };
	const storage = createMultipartStorage({ config: { publicUrl: 'https://upload.test', expires: 900 }, env,
		getStorage: () => ({ bucket: 'private', client: { async getBucketRegionAsync() { return 'cn-test-1'; } } }) });
	assert.equal(await storage.sign('object', 'upload', 1), 'https://upload.test/signed');
});

test('编辑器补丁可重复应用且保留默认上传路径和文件大小校验', () => {
	const source = '\t\tconst files = [...params.files];\nfiles[i].size > parseInt(config.maximumFileSize, 10) * 1024\n\t\t\t$(this).ajaxSubmit({';
	const patched = patchSource(source);
	assert.equal(patchSource(patched), patched);
	assert.ok(patched.includes('filter:composer.uploadTransport'));
	assert.ok(patched.includes('transport.maximumFileSize'));
	assert.ok(patched.includes('$(this).ajaxSubmit(options)'));
});
