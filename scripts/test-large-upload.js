'use strict';

// 手动集成测试：上限只改当前进程，真实上传到私有桶，结束后删除本次附件。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createReadStream, openAsBlob } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { promisify } = require('node:util');
const run = promisify(require('node:child_process').execFile);
const root = path.resolve(__dirname, '..');
const requireApp = require('node:module').createRequire(path.join(root, 'package.json'));
const directory = path.resolve(process.argv[2] || path.join(root, 'backups/upload-100mb'));
const size = 100 * 1024 * 1024;

async function hash(file) {
	const digest = createHash('sha256');
	for await (const chunk of createReadStream(file)) { digest.update(chunk); }
	return digest.digest('hex');
}

async function generate() {
	await fs.mkdir(directory, { recursive: true });
	for (const [name, codec] of [['large.mp4', ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0']],
		['large.wmv', ['-c:v', 'wmv2', '-q:v', '1']]]) {
		const target = path.join(directory, name);
		await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi',
			'-i', 'testsrc2=size=1920x1080:rate=30', '-t', '120', '-fs', String(size - 1024 * 1024),
			...codec, '-pix_fmt', 'yuv420p', '-threads', '2', target], { timeout: 300000 });
		const bytes = (await fs.stat(target)).size;
		assert.ok(bytes > 95 * 1024 * 1024 && bytes <= size, `${name} 样本大小不在 95–100 MiB`);
		console.log(`已生成有效视频：${name} ${bytes} 字节`);
	}
	for (const [name, bytes] of [['boundary.txt', size], ['oversized.txt', size + 1]]) {
		const file = await fs.open(path.join(directory, name), 'w');
		try { await file.truncate(bytes); } finally { await file.close(); }
	}
}

async function main() {
	if (process.argv.includes('--generate')) { await generate(); return; }
	requireApp('./require-main');
	requireApp('./nodebb-global');
	const winston = require('winston');
	winston.configure({ silent: true, transports: [new winston.transports.Console()] });
	const nconf = require('nconf');
	nconf.env({ separator: '__' });
	requireApp('./src/prestart').loadConfig(path.resolve(process.env.CONFIG || path.join(root, 'config.json')));
	const db = requireApp('./src/database');
	const meta = requireApp('./src/meta');
	let server;
	let storage;
	const created = new Set();
	const result = { platform: process.platform, testedLimitKB: size / 1024, checks: [] };
	try {
		await db.init();
		await meta.configs.init();
		result.databaseLimitBeforeKB = Number(meta.config.maximumFileSize);
		// 不落库：先验证目标上限，通过后才允许修改实际论坛配置。
		meta.config.maximumFileSize = size / 1024;
		const [uid] = await db.getSortedSetRange('group:administrators:members', 0, 0);
		assert.ok(Number(uid) > 0, '需要已有管理员用于权限检查');
		storage = await requireApp('./plugins/nodebb-plugin-private-attachments/storage').connect();
		const attachments = requireApp('./plugins/nodebb-plugin-private-attachments/attachments').createAttachments({
			db: { ...db, async setObject(key, value) { created.add(key); await db.setObject(key, value); } },
			meta, image: requireApp('./src/image'), privileges: requireApp('./src/privileges'), getStorage: () => storage,
		});
		const plugins = requireApp('./src/plugins');
		plugins.hooks.register('large-upload-test', { hook: 'filter:uploadPostFile', method: attachments.upload });
		const app = require('express')();
		const token = randomUUID();
		app.use((req, res, next) => {
			if (req.get('X-Test-Token') !== token) { return res.sendStatus(403); }
			req.uid = Number(req.get('X-Test-Uid') || 0);
			next();
		});
		app.post('/api/post/upload', requireApp('./src/middleware/multer').array('files[]', 1),
			requireApp('./src/middleware').validateFiles, requireApp('./src/controllers/uploads').uploadPost);
		app.get('/attachments/:id/:variant/:filename', requireApp('./plugins/nodebb-plugin-private-attachments/routes').createReadHandler({
			attachments, getStorage: () => storage,
			setSafeFileHeaders: requireApp('./src/middleware/uploads').setSafeFileHeaders,
			videoPreview: requireApp('./plugins/nodebb-plugin-private-attachments/video').createVideoPreview({ db, getStorage: () => storage }),
		}));
		app.use((err, req, res, next) => res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 500).json({ code: err.code || 'ERROR' }));
		server = app.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const origin = `http://127.0.0.1:${server.address().port}`;
		const headers = { 'X-Test-Token': token, 'X-Test-Uid': String(uid) };
		for (const name of ['large.mp4', 'large.wmv', 'boundary.txt', 'oversized.txt']) {
			const source = path.join(directory, name);
			const bytes = (await fs.stat(source)).size;
			const started = Date.now();
			const form = new FormData();
			form.append('files[]', await openAsBlob(source), name);
			const response = await fetch(`${origin}/api/post/upload`, { method: 'POST', headers, body: form });
			const payload = await response.json();
			if (name === 'oversized.txt') {
				assert.equal(response.status, 413, '超过 100 MiB 必须被拒绝');
				result.checks.push({ name, bytes, rejected: true });
				continue;
			}
			assert.equal(response.status, 200, `${name} 上传失败：${JSON.stringify(payload)}`);
			const uploaded = payload.response.images[0];
			const record = await db.getObject(`privateAttachment:${uploaded.attachmentId}`);
			assert.equal(Number(record.size), bytes);
			assert.equal(record.sha256, await hash(source));
			const address = origin + uploaded.originalUrl;
			const download = await fetch(address, { headers });
			assert.equal(download.status, 200);
			const downloadedHash = createHash('sha256');
			for await (const chunk of download.body) { downloadedHash.update(chunk); }
			assert.equal(downloadedHash.digest('hex'), record.sha256, '完整下载与原文件必须一致');
			const head = await fetch(address, { method: 'HEAD', headers });
			assert.equal(head.headers.get('content-length'), String(bytes));
			const range = await fetch(address, { headers: { ...headers, Range: 'bytes=-4096' } });
			assert.equal(range.status, 206);
			assert.equal((await range.arrayBuffer()).byteLength, 4096);
			const denied = await fetch(address, { headers: { ...headers, 'X-Test-Uid': '0' } });
			assert.equal(denied.status, 404);
			await denied.arrayBuffer();
			if (process.argv.includes('--video') && /\.(mp4|wmv)$/.test(name)) {
				const poster = await fetch(`${address}?poster=1`, { headers });
				assert.equal(poster.status, 200, `${name} 封面失败`);
				assert.equal(poster.headers.get('content-type'), 'image/jpeg');
				assert.ok((await poster.arrayBuffer()).byteLength > 0);
				if (name.endsWith('.wmv')) {
					const preview = await fetch(`${address}?preview=1`, { headers: { ...headers, Range: 'bytes=0-4095' } });
					assert.equal(preview.status, 206, 'WMV 转码失败');
					assert.equal(preview.headers.get('content-type'), 'video/mp4');
					assert.equal((await preview.arrayBuffer()).byteLength, 4096);
				}
			}
			result.checks.push({ name, bytes, seconds: (Date.now() - started) / 1000, fullDownload: true, range: true,
				accessControl: true, videoProcessing: process.argv.includes('--video') && /\.(mp4|wmv)$/.test(name) });
			console.log(`${process.platform} ${name} 上传、校验值、HEAD、Range、权限检查通过`);
		}
		assert.equal(Number(await db.getObjectField('config', 'maximumFileSize')), result.databaseLimitBeforeKB, '测试不得修改数据库上限');
		await fs.writeFile(path.join(directory, `result-${process.platform}.json`), `${JSON.stringify(result, null, 2)}\n`);
	} finally {
		server?.closeAllConnections();
		server?.close();
		for (const key of created) {
			const record = await db.getObject(key);
			if (record) {
				for (const file of Object.values(JSON.parse(record.variants))) { await storage.client.removeObject(storage.bucket, file.objectKey); }
				await db.delete(key);
			}
		}
		await db.close();
	}
}

main().then(() => { console.log('测试完成，本次附件已清理'); process.exit(0); }).catch((err) => {
	console.error(err.message);
	process.exit(1);
});
