'use strict';

// 手动集成检查：只创建随机测试对象及未加入论坛列表的测试记录，结束后清除，不改已有帖子或用户。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { randomInt } = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
require(path.join(root, 'require-main'));
require(path.join(root, 'nodebb-global'));
const winston = require('winston');
winston.configure({ silent: true, transports: [new winston.transports.Console()] });
const nconf = require('nconf');
nconf.env({ separator: '__' });
require(path.join(root, 'src/prestart')).loadConfig(path.join(root, 'config.json'));
const db = require(path.join(root, 'src/database'));
const meta = require(path.join(root, 'src/meta'));
const { connect } = require(path.resolve(__dirname, '../storage'));
const { createAttachments } = require(path.resolve(__dirname, '../attachments'));
const { createReadHandler } = require(path.resolve(__dirname, '../routes'));
const { createLifecycle } = require(path.resolve(__dirname, '../lifecycle'));
const { createResources } = require(path.resolve(__dirname, '../resources'));
const { registerResourceRoutes } = require(path.resolve(__dirname, '../resource-routes'));
let step = '初始化';

async function main() {
	let dir;
	let server;
	let storage;
	let resources;
	const created = new Set();
	const resourceRecords = new Set();
	const resourceFolders = new Set();
	const testGroups = new Set();
	const scenarioKeys = new Set();
	try {
		await db.init();
		await meta.configs.init();
		const [uid] = await db.getSortedSetRange('group:administrators:members', 0, 0);
		assert.ok(Number(uid) > 0, '需要已有管理员账号验证原生上传权限');
		storage = await connect();
		const trackedDB = {
			...db,
			async setObject(key, data) { created.add(key); await db.setObject(key, data); },
			async setAdd(key, value) { scenarioKeys.add(key); await db.setAdd(key, value); },
		};
		const posts = require(path.join(root, 'src/posts'));
		const topics = require(path.join(root, 'src/topics'));
		const privileges = require(path.join(root, 'src/privileges'));
		const lifecycle = createLifecycle({ db: trackedDB, posts, topics, privileges, meta, getStorage: () => storage, baseUrl: nconf.get('url') });
		const attachments = createAttachments({
			db: trackedDB, meta, image: require(path.join(root, 'src/image')),
			privileges, getStorage: () => storage, canRead: lifecycle.canRead,
		});
		const app = require('express')();
		app.use((req, res, next) => { req.uid = Number(req.get('X-Test-Uid') || 0); next(); });
		const plugins = require(path.join(root, 'src/plugins'));
		const file = require(path.join(root, 'src/file'));
		const image = require(path.join(root, 'src/image'));
		const sharp = require('sharp');
		const uploadPath = nconf.get('upload_path');
		resources = createResources({
			db: { ...db, async setObject(key, data) { if (key.startsWith('privateResource:')) { resourceRecords.add(key); } await db.setObject(key, data); } },
			privileges, user: require(path.join(root, 'src/user')), groups: require(path.join(root, 'src/groups')),
			categories: require(path.join(root, 'src/categories')), getStorage: () => storage, uploadPath, baseUrl: nconf.get('url'),
			detectFile: require('file-type').fileTypeFromFile, detectBuffer: require('file-type').fileTypeFromBuffer,
			dimensions: async (input) => { const { width, height } = await sharp(input).metadata(); return { width, height }; },
			sanitizeSvg: file.sanitizeSvgData,
		});
		plugins.hooks.register('nodebb-plugin-private-attachments', { hook: 'filter:files.storage', method: resources.storage });
		const pass = (req, res, next) => next();
		registerResourceRoutes({ router: app, resources, getStorage: () => storage, file, image, uploadPath,
			upload: require(path.join(root, 'src/middleware/multer')),
			middleware: { authenticateRequest: pass, redirectToHomeIfBanned: pass, ensureLoggedIn: pass, admin: { checkPrivileges: pass }, applyCSRF: pass } });
		plugins.hooks.register('nodebb-plugin-private-attachments', { hook: 'filter:uploadPostFile', method: attachments.upload });
		for (const [hook, method] of Object.entries({
			'filter:post.create': 'preparePost', 'filter:post.edit': 'preparePost', 'filter:posts.purge': 'purge',
			'filter:topic.thumb.associate': 'associateThumb', 'filter:topics.getThumbs': 'getThumbs', 'filter:topics.hasThumbs': 'hasThumbs',
		})) {
			plugins.hooks.register('nodebb-plugin-private-attachments', { hook, method: lifecycle[method] });
		}
		app.post('/api/post/upload',
			require(path.join(root, 'src/middleware/multer')).array('files[]', 20),
			require(path.join(root, 'src/middleware')).validateFiles,
			require(path.join(root, 'src/controllers/uploads')).uploadPost);
		app.post('/api/topic/:tid/thumb',
			require(path.join(root, 'src/middleware/multer')).array('files[]', 20),
			require(path.join(root, 'src/middleware')).validateFiles,
			require(path.join(root, 'src/controllers/uploads')).uploadThumb);
		app.get('/attachments/:id/:variant/:filename', createReadHandler({
			attachments, getStorage: () => storage,
			setSafeFileHeaders: require(path.join(root, 'src/middleware/uploads')).setSafeFileHeaders,
		}));
		server = app.listen(0, '127.0.0.1');
		await once(server, 'listening');
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nodebb-minio-integration-'));
		const imagePath = path.join(dir, 'image.png');
		await require('sharp')({ create: { width: 1600, height: 1200, channels: 3, background: '#336699' } }).png().toFile(imagePath);
		const textPath = path.join(dir, 'file.txt');
		await fs.writeFile(textPath, 'private attachment integration');
		// 强制生成缩略图，仅修改当前检查进程的配置，不写入论坛设置。
		meta.config.resizeImageWidth = 800;
		meta.config.resizeImageWidthThreshold = 1000;
		meta.config.allowedFileExtensions = 'png,txt';
		meta.config.allowTopicsThumbnail = 1;
		meta.config.showPostUploadsAsThumbnails = 1;
		meta.config.topicThumbSize = 256;
		const uploaded = [];
		step = '上传与未发布鉴权';
		for (const source of [imagePath, textPath]) {
			const form = new FormData();
			form.append('files[]', new Blob([await fs.readFile(source)]), path.basename(source));
			const upload = await fetch(`http://127.0.0.1:${server.address().port}/api/post/upload`, {
				method: 'POST', headers: { 'X-Test-Uid': uid }, body: form,
			});
			assert.equal(upload.status, 200);
			const result = (await upload.json()).response.images[0];
			uploaded.push(result);
			const record = await db.getObject(`privateAttachment:${result.attachmentId}`);
			assert.equal(record.status, 'pending');
			assert.equal(Number(record.uploaderUid), Number(uid));
			for (const url of new Set([result.url, result.originalUrl])) {
				const address = `http://127.0.0.1:${server.address().port}${url}`;
				const denied = await fetch(address);
				assert.equal(denied.status, 404);
				await denied.arrayBuffer();
				const response = await fetch(address, { headers: { 'X-Test-Uid': uid } });
				assert.equal(response.status, 200);
				assert.ok((await response.arrayBuffer()).byteLength > 0);
				const range = await fetch(address, { headers: { 'X-Test-Uid': uid, Range: 'bytes=0-7' } });
				assert.equal(range.status, 206);
				assert.equal((await range.arrayBuffer()).byteLength, 8);
			}
		}
		step = '帖子关联与原生权限';
		const cid = randomInt(900000000, 999999990);
		const tid = cid + 1;
		const pid = cid + 2;
		const copyPid = cid + 3;
		async function seed(key, value) {
			if (!scenarioKeys.has(key)) { assert.equal(await db.exists(key), false); scenarioKeys.add(key); }
			await db.setObject(key, value);
		}
		await seed(`category:${cid}`, { cid, name: '附件集成测试', disabled: 0, parentCid: 0, icon: 'fa-comments', color: '#ffffff', bgColor: '#336699' });
		await seed(`topic:${tid}`, { tid, cid, uid: Number(uid), mainPid: pid, timestamp: Date.now() - 1000, thumbs: '[]' });
		for (const privilege of ['read', 'topics:read']) {
			const key = `group:cid:${cid}:privileges:groups:${privilege}:members`;
			assert.equal(await db.exists(key), false);
			scenarioKeys.add(key);
			await db.sortedSetAdd(key, 1, 'guests');
		}
		const content = uploaded.map(file => `![附件](${file.url})`).join('\n');
		const payload = await plugins.hooks.fire('filter:post.create', {
			post: { pid, tid, uid: Number(uid), deleted: 0, content },
			data: { uid: Number(uid), isMain: true },
		});
		await seed(`post:${pid}`, payload.post);
		const source = await db.getObject(`privateAttachment:${uploaded[0].attachmentId}`);
		assert.equal(await lifecycle.canRead(source, 0), true);
		await db.setObjectField(`post:${pid}`, 'deleted', 1);
		assert.equal(await lifecycle.canRead(source, 0), false);
		await db.setObjectField(`post:${pid}`, 'deleted', 0);
		await db.setObjectField(`topic:${tid}`, 'timestamp', Date.now() + 3600000);
		assert.equal(await lifecycle.canRead(source, 0), false);
		await db.setObjectField(`topic:${tid}`, 'timestamp', Date.now() - 1000);
		await db.setObjectField(`category:${cid}`, 'disabled', 1);
		assert.equal(await lifecycle.canRead(source, Number(uid)), false);
		await db.setObjectField(`category:${cid}`, 'disabled', 0);
		assert.equal(await lifecycle.canRead(source, 0), true);
		step = '真实对象复制与缩略图关联';
		const copied = await plugins.hooks.fire('filter:post.create', {
			post: { pid: copyPid, tid, uid: Number(uid), content: uploaded[0].url }, data: { uid: Number(uid) },
		});
		await seed(`post:${copyPid}`, copied.post);
		const [copiedId] = JSON.parse(copied.post.privateAttachmentIds);
		assert.notEqual(copiedId, source.id);
		assert.ok((await storage.client.statObject(storage.bucket, `${copiedId}/original.png`)).size > 0);
		const form = new FormData();
		form.append('files[]', new Blob([await fs.readFile(imagePath)]), 'thumb.png');
		const thumbUpload = await fetch(`http://127.0.0.1:${server.address().port}/api/topic/${tid}/thumb`, {
			method: 'POST', headers: { 'X-Test-Uid': uid }, body: form,
		});
		assert.equal(thumbUpload.status, 200);
		const thumb = (await thumbUpload.json()).response.images[0];
		assert.equal(Number((await db.getObject(`privateAttachment:${thumb.attachmentId}`)).pid), pid);
		assert.equal((await topics.thumbs.get(tid, { thumbsOnly: true }))[0].url, thumb.url);
		step = '编辑与永久删除';
		const edited = await plugins.hooks.fire('filter:post.edit', {
			post: { content: '移除正文附件' }, data: { pid, uid: Number(uid) }, uid: Number(uid),
		});
		await seed(`post:${pid}`, edited.post);
		await plugins.hooks.fire('filter:posts.purge', { pids: [pid] });
		assert.equal(await db.getObject(`privateAttachment:${source.id}`), null);
		assert.ok(await db.getObject(`privateAttachment:${copiedId}`));
		await plugins.hooks.fire('filter:posts.purge', { pids: [copyPid] });
		step = '站点资源和派生图标';
		const folder = `minio-integration-${cid}`;
		resourceFolders.add(path.join(uploadPath, 'system', folder));
		const logo = await file.saveFileToLocal('logo.png', `system/${folder}`, imagePath);
		assert.equal(await file.exists(logo.path), true);
		await assert.rejects(fs.stat(logo.path), { code: 'ENOENT' });
		const smallLogo = path.join(uploadPath, 'system', folder, 'site-logo-x50.png');
		await image.resizeImage({ path: logo.path, target: smallLogo, height: 50, type: 'image/png' });
		assert.equal((await image.size(smallLogo)).height, 50);
		for (const size of [36, 48, 72, 96, 144, 192, 512]) {
			const target = path.join(uploadPath, 'system', folder, `touchicon-${size}.png`);
			await image.resizeImage({ path: imagePath, target, width: size, height: size, type: 'image/png' });
			assert.equal((await image.size(target)).width, size);
		}
		const origin = `http://127.0.0.1:${server.address().port}`;
		const logoResponse = await fetch(origin + logo.url);
		assert.equal(logoResponse.status, 200);
		await logoResponse.arrayBuffer();
		await file.saveFileToLocal('logo.png', `system/${folder}`, imagePath);
		assert.equal((await image.size(logo.path)).width, 1600);
		step = '头像、群组封面及生成版块图标';
		const avatar = await image.uploadImage(`${folder}-profileavatar.png`, `profile/uid-${uid}`, { path: imagePath, uid, name: 'avatar' });
		await resources.getReadable(resources.logicalPath(avatar.path), Number(uid));
		const groupName = folder;
		await seed(`group:${groupName}`, { name: groupName, hidden: '1', slug: groupName });
		testGroups.add(groupName);
		await db.sortedSetAdd('groups:createtime', Date.now(), groupName);
		const groupImage = path.join(dir, 'group.png');
		await fs.copyFile(imagePath, groupImage);
		const groupCover = await require(path.join(root, 'src/groups')).updateCover(Number(uid), { groupName, file: { path: groupImage } });
		const groupResource = await resources.getReadable(resources.logicalPath(groupCover.url), Number(uid));
		assert.equal(groupResource.record.scope, 'group');
		await assert.rejects(resources.getReadable(resources.logicalPath(groupCover.url), 0), { status: 404 });
		const icons = require(path.join(root, 'src/categories')).icons;
		await icons.regenerate(cid);
		const iconPath = path.join(uploadPath, 'category', `category-${cid}-icon.png`);
		assert.equal(await file.exists(iconPath), true);
		await icons.flush(cid);
		assert.equal(await file.exists(iconPath), false);
		step = '自定义表情、SVG 安全和导出';
		const emojiForm = new FormData();
		emojiForm.append('fileName', `${folder}.png`);
		emojiForm.append('emojiImage', new Blob([await fs.readFile(imagePath)]), 'emoji.png');
		const emojiResponse = await fetch(`${origin}/api/admin/plugins/emoji/upload`, { method: 'POST', body: emojiForm, headers: { 'X-Test-Uid': uid } });
		assert.equal(emojiResponse.status, 200);
		await emojiResponse.arrayBuffer();
		const emojiImage = await fetch(`${origin}/assets/plugins/nodebb-plugin-emoji/emoji/customizations/${folder}.png`);
		assert.equal(emojiImage.status, 200);
		await emojiImage.arrayBuffer();
		const svgPath = path.join(uploadPath, 'system', folder, 'safe.svg');
		await file.writeBuffer(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>');
		assert.equal((await file.readBuffer(svgPath)).toString().includes('<script>'), false);
		const archive = { append(stream) { stream.resume(); } };
		assert.equal((await file.storage('export', path.join(uploadPath, 'profile', `uid-${uid}`), { archive })).handled, true);
		step = '插件启动与默认图标';
		await require(path.resolve(__dirname, '../library')).init({ router: require('express').Router(), middleware: require(path.join(root, 'src/middleware')) });
		console.log('真实 PostgreSQL 与 MinIO 验证通过：帖子附件、权限及删除，以及头像、群组封面、Logo 派生图、7 种图标、版块图标、表情和 SVG。');
	} finally {
		server?.closeAllConnections();
		server?.close();
		for (const key of resourceRecords) {
			const record = await db.getObject(key);
			if (record) { await resources.storage({ operation: 'delete', path: path.join(nconf.get('upload_path'), record.logicalPath) }); }
		}
		for (const folder of resourceFolders) { await resources.storage({ operation: 'delete', path: folder }); }
		for (const name of testGroups) { await db.sortedSetRemove('groups:createtime', name); }
		for (const key of created) {
			const record = await db.getObject(key);
			if (record) {
				for (const file of Object.values(JSON.parse(record.variants))) {
					await storage.client.removeObject(storage.bucket, file.objectKey);
				}
				await db.delete(key);
			}
		}
		for (const key of scenarioKeys) { await db.delete(key); }
		if (dir) { await fs.rm(dir, { recursive: true, force: true }); }
		if (db.pool) { await db.pool.end(); }
	}
}

main().then(() => {
	console.log('本次测试对象和元数据已清除。');
	process.exit(0);
}).catch((err) => {
	console.error(`集成检查失败（${step}），请检查本地服务及权限；未输出底层错误或凭证。`);
	// 只输出代码位置，不输出可能包含请求信息的底层错误消息。
	console.error((err.stack || '').split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 3).join('\n'));
	process.exit(1);
});
