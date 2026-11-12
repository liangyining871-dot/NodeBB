'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { Readable } = require('node:stream');
const { once } = require('node:events');
const sharp = require('sharp');
const { fileTypeFromBuffer, fileTypeFromFile } = require('file-type');
const { createResources } = require('../resources');
const { registerResourceRoutes } = require('../resource-routes');

async function fixture(t) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nodebb-resources-test-'));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const uploadPath = path.join(dir, 'uploads');
	const records = new Map();
	const sets = new Map();
	const objects = new Map();
	const db = {
		async getObject(key) { return records.get(key) || null; },
		async setObject(key, value) { records.set(key, { ...records.get(key), ...value }); },
		async setObjectField(key, field, value) { await this.setObject(key, { [field]: value }); },
		async delete(key) { records.delete(key); sets.delete(key); },
		async setAdd(key, value) { if (!sets.has(key)) { sets.set(key, new Set()); } sets.get(key).add(value); },
		async setRemove(key, value) { sets.get(key)?.delete(value); },
		async getSetMembers(key) { return [...(sets.get(key) || [])]; },
	};
	const client = {
		async putObject(bucket, key, buffer) { objects.set(key, Buffer.from(buffer)); },
		async fPutObject(bucket, key, source) { objects.set(key, await fs.readFile(source)); },
		async removeObject(bucket, key) { objects.delete(key); },
		async statObject(bucket, key) { return { size: objects.get(key).length }; },
		async getObject(bucket, key) { return Readable.from(objects.get(key)); },
		async getPartialObject(bucket, key, offset, length) { return Readable.from(objects.get(key).subarray(offset, offset + length)); },
	};
	const state = { viewUsers: true, viewGroups: true, hidden: true, categoryRead: true, disabled: 0 };
	const privileges = {
		global: { async can(name) { return name === 'view:users' ? state.viewUsers : state.viewGroups; } },
		categories: { async can() { return state.categoryRead; } },
		admin: { async can(name, uid) { return uid === 1; } },
	};
	const getStorage = () => ({ client, bucket: 'nodebb' });
	const resources = createResources({
		db, privileges, getStorage, uploadPath, baseUrl: 'https://forum.example/forum', relativePath: '/forum',
		user: { async exists(uid) { return uid === 12; }, async isAdministrator(uid) { return uid === 1; }, async isGlobalModerator(uid) { return uid === 2; } },
		groups: { async exists() { return true; }, async isHidden() { return state.hidden; }, async isMember(uid) { return uid === 12; }, async isInvited(uid) { return uid === 13; } },
		categories: { async exists() { return true; }, async getCategoryField() { return state.disabled; } },
		detectFile: fileTypeFromFile, detectBuffer: fileTypeFromBuffer,
		dimensions: async input => { const { width, height } = await sharp(input).metadata(); return { width, height }; },
		sanitizeSvg: source => source.replace(/<script>.*?<\/script>/g, ''),
	});
	const png = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#336699' } }).png().toBuffer();
	const op = (operation, name, data = {}) => resources.storage({ operation, path: path.join(uploadPath, name), ...data });
	const save = (name, data = {}) => op('save', name, { buffer: png, ...data });
	return { dir, uploadPath, resources, records, sets, objects, client, state, getStorage, png, op, save };
}

test('资源按随机 ID 存储，保留稳定论坛地址及属性，不向上传目录写文件', async (t) => {
	const f = await fixture(t);
	const result = (await f.save('system/logo.png')).result;
	assert.equal(result.url, '/assets/uploads/system/logo.png');
	const { record } = await f.resources.getReadable('system/logo.png', 0);
	assert.match(record.objectKey, /^[a-f0-9-]{36}\/original.png$/);
	assert.equal(record.width, 4);
	assert.equal(record.height, 3);
	assert.equal(record.mime, 'image/png');
	assert.equal(record.status, 'ready');
	await assert.rejects(fs.stat(f.uploadPath), { code: 'ENOENT' });
	assert.equal((await f.op('stat', 'system/logo.png')).result.size, f.png.length);
	assert.deepEqual((await f.op('read', 'system/logo.png')).result, f.png);
});

test('路径边界、子路径、中文和百分号文件名正确处理，内置及临时文件不接管', async (t) => {
	const f = await fixture(t);
	const name = 'system/图%20片.png';
	const { result } = await f.save(name);
	assert.equal(f.resources.logicalPath(`/forum${result.url}`), name);
	assert.equal(f.resources.logicalPath(`https://forum.example/forum${result.url}`), name);
	assert.equal(f.resources.logicalPath('https://other.example/assets/uploads/system/logo.png'), null);
	assert.equal((await f.resources.storage({ operation: 'stat', path: path.join(f.dir, 'temp.png') })).handled, undefined);
	assert.throws(() => f.resources.logicalPath('/forum/assets/uploads/../secret'), /invalid-path/);
});

test('头像继承资料页权限，隐藏群组检查成员和邀请，版块资源检查版块状态', async (t) => {
	const f = await fixture(t);
	await f.save('profile/uid-12/12-profileavatar.png');
	f.state.viewUsers = false;
	await assert.rejects(f.resources.getReadable('profile/uid-12/12-profileavatar.png', 99), { status: 404 });
	await f.resources.getReadable('profile/uid-12/12-profileavatar.png', 12);
	await f.save('files/group.png', { resource: { scope: 'group', owner: '研发组', type: 'group-cover' } });
	await assert.rejects(f.resources.getReadable('files/group.png', 99), { status: 404 });
	for (const uid of [1, 2, 12, 13]) { await f.resources.getReadable('files/group.png', uid); }
	f.state.viewGroups = false;
	await assert.rejects(f.resources.getReadable('files/group.png', 12), { status: 404 });
	await f.save('category/category-3-icon.png');
	await f.resources.getReadable('category/category-3-icon.png', 99);
	f.state.disabled = 1;
	await assert.rejects(f.resources.getReadable('category/category-3-icon.png', 1), { status: 404 });
	await f.save('other/report.png');
	await assert.rejects(f.resources.getReadable('other/report.png', 99), { status: 404 });
	await f.resources.getReadable('other/report.png', 1);
});

test('固定地址替换先完成上传，失败保留原对象；成功替换和删除清理 MinIO', async (t) => {
	const f = await fixture(t);
	await f.save('system/logo.png');
	const original = (await f.resources.getReadable('system/logo.png', 0)).record;
	const put = f.client.putObject;
	f.client.putObject = async () => { throw new Error('sensitive credentials'); };
	await assert.rejects(f.save('system/logo.png'), /MinIO 资源操作失败/);
	assert.equal((await f.resources.getReadable('system/logo.png', 0)).record.id, original.id);
	f.client.putObject = put;
	await f.save('system/logo.png');
	assert.equal(f.objects.has(original.objectKey), false);
	assert.equal(f.objects.size, 1);
	await f.op('delete', 'system/logo.png');
	assert.equal(f.objects.size, 0);
	await assert.rejects(f.resources.getReadable('system/logo.png', 0), { status: 404 });
});

test('虚拟目录支持管理、唯一文件名、账户清理及群组改名', async (t) => {
	const f = await fixture(t);
	await f.op('mkdir', 'new-folder');
	assert.equal((await f.op('stat', 'new-folder')).result.isDirectory, true);
	await f.op('delete', 'new-folder');
	assert.equal((await f.op('stat', 'new-folder')).result, null);
	await f.save('profile/uid-12/avatar.png');
	const duplicate = (await f.save('profile/uid-12/avatar.png', { unique: true })).result;
	assert.notEqual(duplicate.url, '/assets/uploads/profile/uid-12/avatar.png');
	assert.equal((await f.op('list', 'profile/uid-12')).result.length, 2);
	await f.resources.deleteOwner('user', 12);
	assert.equal(f.objects.size, 0);
	await f.save('files/group.png', { resource: { scope: 'group', owner: 'old' } });
	await f.resources.renameOwner('group', 'old', 'new');
	assert.equal((await f.resources.getReadable('files/group.png', 12)).record.owner, 'new');
	await f.resources.deleteOwner('group', 'old');
	assert.equal(f.objects.size, 1);
	await f.resources.deleteOwner('group', 'new');
	assert.equal(f.objects.size, 0);
});

test('站点资源与表情代理支持匿名读取和 HEAD，头像鉴权失败不回退，表情上传使用临时文件', async (t) => {
	const f = await fixture(t);
	const app = require('express')();
	app.use((req, res, next) => { req.uid = Number(req.get('X-Test-Uid') || 0); next(); });
	const next = (req, res, done) => done();
	const admin = (req, res, done) => (req.uid === 1 ? done() : res.sendStatus(403));
	const upload = require('multer')({ dest: f.dir });
	registerResourceRoutes({ router: app, resources: f.resources, getStorage: f.getStorage, uploadPath: f.uploadPath,
		middleware: { authenticateRequest: next, redirectToHomeIfBanned: next, ensureLoggedIn: admin, admin: { checkPrivileges: admin }, applyCSRF: next },
		file: { async writeBuffer(target, buffer) { await f.resources.storage({ operation: 'save', path: target, buffer }); } },
		image: { async isFileTypeAllowed(source) { await sharp(source).metadata(); }, async checkDimensions() {} }, upload,
	});
	const server = app.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => { server.closeAllConnections(); server.close(); });
	const origin = `http://127.0.0.1:${server.address().port}`;
	await f.save('system/logo.png');
	await f.save('emoji/face.png');
	for (const route of ['/assets/uploads/system/logo.png', '/assets/plugins/nodebb-plugin-emoji/emoji/customizations/face.png']) {
		const response = await fetch(origin + route);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('cache-control'), 'private, no-store');
		assert.ok((await response.arrayBuffer()).byteLength > 0);
		assert.equal((await fetch(origin + route, { method: 'HEAD' })).status, 200);
	}
	f.state.viewUsers = false;
	await f.save('profile/uid-12/avatar.png');
	const denied = await fetch(`${origin}/assets/uploads/profile/uid-12/avatar.png`);
	assert.equal(denied.status, 404);
	await denied.arrayBuffer();
	const form = new FormData();
	form.append('fileName', 'custom-image.png');
	form.append('emojiImage', new Blob([f.png]), 'source.png');
	const response = await fetch(`${origin}/api/admin/plugins/emoji/upload`, { method: 'POST', headers: { 'X-Test-Uid': '1' }, body: form });
	assert.equal(response.status, 200);
	await response.arrayBuffer();
	await f.resources.getReadable('emoji/custom-image.png', 0);
});
