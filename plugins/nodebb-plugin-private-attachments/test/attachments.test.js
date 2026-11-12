'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { once } = require('node:events');
const express = require('express');
const { createAttachments } = require('../attachments');
const { createReadHandler } = require('../routes');

async function fixture(t, { thumbnail = false } = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nodebb-attachment-test-'));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const file = { path: path.join(dir, 'upload'), name: '测试.pdf', type: 'text/html' };
	await fs.writeFile(file.path, '0123456789');
	const records = new Map();
	const objects = new Map();
	const client = {
		async fPutObject(bucket, key, source) { objects.set(key, await fs.readFile(source)); },
		async statObject(bucket, key) { return { size: objects.get(key).length }; },
		async getObject(bucket, key) { return Readable.from(objects.get(key)); },
		async getPartialObject(bucket, key, offset, length) { return Readable.from(objects.get(key).subarray(offset, offset + length)); },
	};
	const db = {
		async setObject(key, value) { records.set(key, { ...value }); },
		async setObjectField(key, field, value) { records.get(key)[field] = value; },
		async getObject(key) { return records.get(key); },
	};
	const image = {
		async isFileTypeAllowed() {},
		async checkDimensions() { return { width: 2400, height: 1600 }; },
		async size() { return { width: 2400, height: 1600 }; },
		async stripEXIF() {},
		async resizeImage({ target }) { await fs.writeFile(target, 'thumbnail'); },
	};
	const config = { maximumFileSize: 1024, resizeImageWidth: thumbnail ? 800 : 0, resizeImageWidthThreshold: 1000 };
	const privileges = { global: { async can() { return true; } } };
	const getStorage = () => ({ client, bucket: 'nodebb' });
	const attachments = createAttachments({ db, image, meta: { config }, privileges, getStorage, relativePath: '/forum' });
	const app = express();
	app.use((req, res, next) => { req.uid = Number(req.get('X-Test-Uid') || 0); next(); });
	app.get('/forum/attachments/:id/:variant/:filename', createReadHandler({
		attachments, getStorage,
		setSafeFileHeaders(res) { res.set('X-Content-Type-Options', 'nosniff'); },
	}));
	const server = app.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => { server.closeAllConnections(); server.close(); });
	async function send(method, url, uid = 0, headers = {}) {
		const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
			method, headers: { 'X-Test-Uid': String(uid), ...headers },
		});
		return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
	}
	return { attachments, records, objects, client, file, db, image, config, privileges, send };
}

test('上传保存元数据、随机对象路径及稳定论坛地址，不信任浏览器 MIME', async (t) => {
	const f = await fixture(t);
	const result = await f.attachments.upload({ file: f.file, uid: 12, detected: { mime: 'application/pdf', ext: 'pdf' } });
	const record = [...f.records.values()][0];
	assert.equal(record.status, 'pending');
	assert.equal(record.uploaderUid, 12);
	assert.equal(record.mime, 'application/pdf');
	assert.equal(record.size, 10);
	assert.equal(record.sha256, createHash('sha256').update('0123456789').digest('hex'));
	assert.equal(record.objectKey, `${result.attachmentId}/original.pdf`);
	assert.ok(result.url.startsWith(`/forum/attachments/${result.attachmentId}/original/`));
	assert.equal(result.url.includes('minio'), false);
	assert.equal((await f.attachments.getReadable(result.attachmentId, 12, 'original')).record.id, record.id);
	for (const uid of [0, 13]) {
		await assert.rejects(f.attachments.getReadable(result.attachmentId, uid, 'original'), { status: 404 });
	}
});

test('无上传权限、游客和超大文件不会写对象或元数据', async (t) => {
	const f = await fixture(t);
	await assert.rejects(f.attachments.upload({ file: f.file, uid: 0 }), { status: 403 });
	f.privileges.global.can = async () => false;
	await assert.rejects(f.attachments.upload({ file: f.file, uid: 12 }), { status: 403 });
	f.privileges.global.can = async () => true;
	f.config.maximumFileSize = 0.001;
	await assert.rejects(f.attachments.upload({ file: f.file, uid: 12 }), { status: 400 });
	assert.equal(f.records.size, 0);
	assert.equal(f.objects.size, 0);
});

test('图片原件与缩略图使用同一 ID、同一鉴权，处理临时文件被移除', async (t) => {
	const f = await fixture(t, { thumbnail: true });
	let thumbnailPath;
	f.image.resizeImage = async ({ target }) => { thumbnailPath = target; await fs.writeFile(target, 'thumbnail'); };
	const result = await f.attachments.upload({ file: { ...f.file, name: '图.png' }, uid: 12, detected: { mime: 'image/png', ext: 'png' } });
	assert.ok(result.url.includes('/thumbnail/'));
	assert.equal(f.objects.size, 2);
	await assert.rejects(fs.stat(thumbnailPath), { code: 'ENOENT' });
	await assert.rejects(f.attachments.getReadable(result.attachmentId, 13, 'thumbnail'), { status: 404 });
	await f.attachments.getReadable(result.attachmentId, 12, 'thumbnail');
});

test('对象写入失败或最终数据库写入失败不会发布附件，也不泄露底层错误', async (t) => {
	for (const failure of ['object', 'database']) {
		const f = await fixture(t);
		if (failure === 'object') {
			f.client.fPutObject = async () => { throw new Error('secret endpoint'); };
		} else {
			const save = f.db.setObjectField;
			f.db.setObjectField = async (key, field, value) => {
				if (value === 'pending') { throw new Error('secret database'); }
				await save(key, field, value);
			};
		}
		await assert.rejects(f.attachments.upload({ file: f.file, uid: 12 }), (err) => err.status === 503 && !err.message.includes('secret'));
		const record = [...f.records.values()][0];
		assert.equal(record.status, 'failed');
		await assert.rejects(f.attachments.getReadable(record.id, 12, 'original'), { status: 404 });
	}
});

test('GET、HEAD、视频 Range 均鉴权，禁止缓存，不返回 MinIO 地址', async (t) => {
	const f = await fixture(t);
	const result = await f.attachments.upload({ file: { ...f.file, name: 'video.mp4' }, uid: 12, detected: { mime: 'video/mp4', ext: 'mp4' } });
	const get = headers => f.send('GET', result.url, 12, headers);
	assert.equal((await f.send('GET', result.url)).status, 404);
	assert.equal((await f.send('HEAD', result.url, 13)).status, 404);
	assert.equal((await f.send('GET', result.url, 13, { Range: 'bytes=0-2' })).status, 404);
	const full = await get();
	assert.equal(full.status, 200);
	assert.equal(full.body, '0123456789');
	assert.equal(full.headers['content-length'], '10');
	assert.match(full.headers['content-disposition'], /^inline/);
	assert.equal(full.headers['cache-control'], 'private, no-store');
	assert.equal(full.headers['x-content-type-options'], 'nosniff');
	assert.equal(full.headers.location, undefined);
	for (const [range, expected, body] of [['bytes=2-4', 'bytes 2-4/10', '234'], ['bytes=-3', 'bytes 7-9/10', '789'], ['bytes=8-', 'bytes 8-9/10', '89']]) {
		const res = await get({ Range: range });
		assert.equal(res.status, 206);
		assert.equal(res.headers['content-range'], expected);
		assert.equal(res.body, body);
	}
	const unsatisfied = await get({ Range: 'bytes=99-' });
	assert.equal(unsatisfied.status, 416);
	assert.equal(unsatisfied.headers['content-range'], 'bytes */10');
	assert.equal((await get({ Range: 'bytes=0-1,4-5' })).status, 200);
	assert.equal((await get({ Range: 'items=99-' })).status, 200);
	assert.equal((await get({ Range: 'bytes=0-2', 'If-Range': '"old"' })).status, 200);
	const head = await f.send('HEAD', result.url, 12, { Range: 'bytes=0-2' });
	assert.equal(head.status, 200);
	assert.equal(head.headers['content-length'], '10');
	assert.equal(head.body, '');
});

test('普通文件强制下载；非法 ID、变体和不存在对象不暴露底层错误', async (t) => {
	const f = await fixture(t);
	const result = await f.attachments.upload({ file: f.file, uid: 12 });
	const res = await f.send('GET', result.url, 12);
	assert.equal(res.status, 200);
	assert.equal(res.headers['content-type'], 'application/octet-stream');
	assert.match(res.headers['content-disposition'], /^attachment/);
	assert.equal((await f.send('GET', result.url.replace('/original/', '/unknown/'), 12)).status, 404);
	assert.equal((await f.send('GET', '/forum/attachments/invalid/original/file', 12)).status, 404);
	f.client.statObject = async () => { throw Object.assign(new Error('secret endpoint'), { code: 'NoSuchKey' }); };
	assert.equal((await f.send('GET', result.url, 12)).status, 404);
	f.client.statObject = async () => { throw new Error('secret endpoint'); };
	const failed = await f.send('GET', result.url, 12);
	assert.equal(failed.status, 503);
	assert.equal(failed.body.includes('secret'), false);
});
