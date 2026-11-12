'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { createLifecycle } = require('../lifecycle');
const { attachmentUrl } = require('../attachments');

function fixture() {
	const records = new Map();
	const sets = new Map();
	const objects = new Map();
	const permissions = new Map();
	const db = {
		async getObject(key) { return records.get(key) || null; },
		async setObject(key, value) { records.set(key, { ...records.get(key), ...value }); },
		async setObjectField(key, field, value) { await this.setObject(key, { [field]: value }); },
		async setAdd(key, id) { if (!sets.has(key)) { sets.set(key, new Set()); } sets.get(key).add(id); },
		async getSetMembers(key) { return [...(sets.get(key) || [])]; },
		async delete(key) { records.delete(key); sets.delete(key); },
	};
	const posts = { async getPostFields(pid) { return await db.getObject(`post:${pid}`); } };
	const topics = {
		async getTopicFields(tid) { return await db.getObject(`topic:${tid}`) || { mainPid: 0, thumbs: [] }; },
		async getTopicField(tid, field) { return (await this.getTopicFields(tid))[field]; },
	};
	const privileges = {
		topics: {
			async canRead(tid, uid) { return !permissions.get(uid)?.topicDenied; },
			async canEdit(tid, uid) { return uid === 12; },
		},
		posts: {
			async get(pids, uid) {
				return pids.map(() => ({ read: true, 'topics:read': true, 'posts:view_deleted': uid === 12, ...permissions.get(uid) }));
			},
		},
	};
	const client = {
		async copyObject(bucket, target, source) { objects.set(target, Buffer.from(objects.get(source.replace(`/${bucket}/`, '')))); },
		async removeObject(bucket, key) { objects.delete(key); },
	};
	const meta = { config: { showPostUploadsAsThumbnails: 1 } };
	const service = createLifecycle({ db, posts, topics, privileges, meta, getStorage: () => ({ client, bucket: 'nodebb' }), baseUrl: 'https://forum.example/forum', relativePath: '/forum' });
	function seed(uid = 12) {
		const id = randomUUID();
		const record = {
			id, uploaderUid: uid, name: "图(a)'b.png", mime: 'image/png', status: 'pending', objectKey: `${id}/original.png`,
			variants: JSON.stringify({
				original: { objectKey: `${id}/original.png`, mime: 'image/png', size: 10 },
				thumbnail: { objectKey: `${id}/thumbnail.png`, mime: 'image/png', size: 5 },
			}),
		};
		records.set(`privateAttachment:${id}`, record);
		objects.set(`${id}/original.png`, Buffer.from('0123456789'));
		objects.set(`${id}/thumbnail.png`, Buffer.from('01234'));
		return { record, url: attachmentUrl('/forum', id, 'original', record.name) };
	}
	async function save(pid, content, uid = 12, thumbs) {
		const old = await db.getObject(`post:${pid}`);
		const post = { pid, tid: 1, uid: 12, content };
		const data = { pid, uid, content, thumbs };
		if (pid === 10 && !old) { data.isMain = true; }
		const payload = await service.preparePost({ post, data, uid });
		await db.setObject(`post:${pid}`, payload.post);
		return payload;
	}
	return { service, seed, save, records, sets, objects, db, client, permissions };
}

test('未发布附件仅上传者可读；关联准备未提交时不提前开放', async () => {
	const f = fixture();
	const { record, url } = f.seed();
	assert.equal(await f.service.canRead(record, 12), true);
	assert.equal(await f.service.canRead(record, 1), false);
	const payload = await f.service.preparePost({ post: { pid: 10, tid: 1, content: url }, data: { uid: 12, isMain: true } });
	const prepared = await f.db.getObject(`privateAttachment:${record.id}`);
	assert.equal(await f.service.canRead(prepared, 13), false);
	await f.db.setObject('post:10', payload.post);
	assert.equal(await f.service.canRead(prepared, 13), true);
});

test('附件实时继承版块、主题、删除及禁用权限，上传者没有读取特权', async () => {
	const f = fixture();
	const { record, url } = f.seed();
	await f.save(10, `![图](${url})`);
	const attached = await f.db.getObject(`privateAttachment:${record.id}`);
	assert.equal(await f.service.canRead(attached, 13), true);
	for (const permission of [{ read: false }, { 'topics:read': false }, { disabled: true }, { topicDenied: true }]) {
		f.permissions.set(13, permission);
		assert.equal(await f.service.canRead(attached, 13), false);
	}
	f.permissions.clear();
	await f.db.setObjectField('post:10', 'deleted', 1);
	assert.equal(await f.service.canRead(attached, 13), false);
	assert.equal(await f.service.canRead(attached, 12), true);
	f.permissions.set(12, { read: false });
	assert.equal(await f.service.canRead(attached, 12), false);
	await f.db.setObjectField('post:10', 'deleted', 0);
	f.permissions.clear();
	assert.equal(await f.service.canRead(attached, 13), true);
});

test('跨帖复制生成独立记录和所有变体，正文及源内容同步改写，同帖重复引用不复制', async () => {
	const f = fixture();
	const { record, url } = f.seed();
	await f.save(10, `![图](${url})`);
	const payload = await f.service.preparePost({ post: { pid: 11, tid: 1, content: `${url} ${url}`, sourceContent: url }, data: { uid: 13 } });
	const [cloneId] = JSON.parse(payload.post.privateAttachmentIds);
	assert.notEqual(cloneId, record.id);
	assert.equal(payload.post.content.includes(record.id), false);
	assert.equal(payload.post.sourceContent.includes(cloneId), true);
	assert.equal(payload.data.content, payload.post.content);
	const clone = await f.db.getObject(`privateAttachment:${cloneId}`);
	assert.equal(clone.uploaderUid, 13);
	assert.equal(clone.pid, 11);
	assert.equal(clone.copiedFrom, record.id);
	assert.equal(f.objects.size, 4);
	await f.db.setObject('post:11', payload.post);
	await f.save(11, payload.post.content, 13);
	assert.equal(f.objects.size, 4);
	await f.service.purge({ pids: [10] });
	assert.equal(f.objects.size, 2);
	assert.equal(await f.service.canRead(clone, 13), true);
});

test('无源附件权限不可复制，整批验证失败不会提前绑定其他附件', async () => {
	const f = fixture();
	const own = f.seed();
	const other = f.seed(14);
	await assert.rejects(f.save(10, `${own.url} ${other.url}`), /no-privileges/);
	assert.equal((await f.db.getObject(`privateAttachment:${own.record.id}`)).status, 'pending');
	assert.equal(f.sets.size, 0);
	await f.save(10, own.url);
	f.permissions.set(13, { topicDenied: true });
	await assert.rejects(f.save(11, own.url, 13), /no-privileges/);
	assert.equal(f.objects.size, 4);
});

test('并发使用同一未发布附件会串行认领并复制，不产生跨帖子共享 ID', async () => {
	const f = fixture();
	const { url } = f.seed();
	const make = pid => f.service.preparePost({ post: { pid, tid: 1, content: url }, data: { uid: 12 } });
	const [a, b] = await Promise.all([make(10), make(11)]);
	assert.notEqual(a.post.privateAttachmentIds, b.post.privateAttachmentIds);
	assert.equal(f.objects.size, 4);
});

test('正文移除链接保留历史关联；永久删除清理原件、缩略图和记录，可幂等重试', async () => {
	const f = fixture();
	const { record, url } = f.seed();
	await f.save(10, url);
	await f.save(10, '移除链接后的正文');
	assert.equal(f.objects.size, 2);
	assert.equal(await f.service.canRead(await f.db.getObject(`privateAttachment:${record.id}`), 13), true);
	await f.service.purge({ pids: [10] });
	await f.service.purge({ pids: [10] });
	assert.equal(f.objects.size, 0);
	assert.equal(await f.db.getObject(`privateAttachment:${record.id}`), null);
	assert.equal(f.sets.size, 0);
});

test('删除中失败保留不可读状态和索引，重试永久删除可继续', async () => {
	const f = fixture();
	const { record, url } = f.seed();
	await f.save(10, url);
	const remove = f.client.removeObject;
	f.client.removeObject = async () => { throw new Error('sensitive endpoint'); };
	await assert.rejects(f.service.purge({ pids: [10] }), /附件删除失败/);
	const failed = await f.db.getObject(`privateAttachment:${record.id}`);
	assert.equal(failed.status, 'delete_failed');
	assert.equal(await f.service.canRead(failed, 12), false);
	assert.equal(f.sets.size, 1);
	f.client.removeObject = remove;
	await f.service.purge({ pids: [10] });
	assert.equal(f.objects.size, 0);
});

test('新主题和已有主题缩略图绑定主帖，修正论坛地址，不拼接本地上传目录', async () => {
	const f = fixture();
	const first = f.seed();
	await f.db.setObject('topic:1', { mainPid: 10, thumbs: [] });
	await f.save(10, '正文没有图片', 12, [first.url]);
	const second = f.seed();
	await assert.rejects(f.service.associateThumb({ id: 1, path: second.url, uid: 13 }), /no-privileges/);
	const associated = await f.service.associateThumb({ id: 1, path: second.url, uid: 12 });
	assert.equal(associated.isLocal, false);
	assert.equal(await f.service.canRead(await f.db.getObject(`privateAttachment:${second.record.id}`), 13), true);
	const data = await f.service.getThumbs({ tids: [1], thumbsOnly: true, thumbs: [[{ path: associated.path, url: '/assets/uploads/wrong' }]] });
	assert.equal(data.thumbs[0][0].url, associated.path);
});

test('自动缩略图仅使用正文当前引用，正文中的外站链接和无效 URL 不被接管', async () => {
	const f = fixture();
	const { url } = f.seed();
	await f.save(10, `http://[ ![图片](${url})`);
	await f.db.setObject('topic:1', { mainPid: 10, thumbs: [] });
	const data = { tids: [1], thumbsOnly: false, thumbs: [[]] };
	const thumbs = (await f.service.getThumbs(data)).thumbs[0];
	assert.equal(thumbs.length, 1);
	assert.equal(thumbs[0].id, '1');
	const explicit = await f.service.getThumbs({ ...data, thumbs: [[{ path: url, url }]] });
	assert.equal(explicit.thumbs[0].length, 1);
	await f.save(10, '已移除图片');
	assert.equal((await f.service.getThumbs({ ...data, thumbs: [[]] })).thumbs[0].length, 0);
	const payload = await f.save(11, `https://other.example${url}`, 13);
	assert.deepEqual(JSON.parse(payload.post.privateAttachmentIds), []);
});
