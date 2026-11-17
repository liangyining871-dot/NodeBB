'use strict';

// 手动集成检查：读取现有附件并按正常预览流程生成缓存，不修改原件或帖子。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const id = process.argv[2];
const requireApp = require('node:module').createRequire(path.join(root, 'package.json'));

async function main() {
	assert.match(id || '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, '请传入需要验证的附件 ID');
	requireApp('./require-main');
	requireApp('./nodebb-global');
	const winston = require('winston');
	winston.configure({ silent: true, transports: [new winston.transports.Console()] });
	const nconf = require('nconf');
	nconf.env({ separator: '__' });
	requireApp('./src/prestart').loadConfig(path.join(root, 'config.json'));
	const db = requireApp('./src/database');
	const posts = requireApp('./src/posts');
	const meta = requireApp('./src/meta');
	let server;
	try {
		await db.init();
		await meta.configs.init();
		const record = await db.getObject(`privateAttachment:${id}`);
		assert.ok(record, '附件不存在');
		const original = record.variants;
		const [uid] = await db.getSortedSetRange('group:administrators:members', 0, 0);
		assert.ok(Number(uid) > 0, '需要已有管理员检查读取权限');
		const storage = await requireApp('./plugins/nodebb-plugin-private-attachments/storage').connect();
		const services = { db, posts, meta, topics: requireApp('./src/topics'), privileges: requireApp('./src/privileges'),
			getStorage: () => storage, baseUrl: nconf.get('url'), relativePath: nconf.get('relative_path') || '' };
		const lifecycle = requireApp('./plugins/nodebb-plugin-private-attachments/lifecycle').createLifecycle(services);
		const attachments = requireApp('./plugins/nodebb-plugin-private-attachments/attachments').createAttachments({
			...services, canRead: lifecycle.canRead,
		});
		const token = randomUUID();
		const app = require('express')();
		app.use((req, res, next) => {
			if (req.get('X-Test-Token') !== token) { return res.sendStatus(403); }
			req.uid = Number(req.get('X-Test-Uid') || 0);
			next();
		});
		const prefix = services.relativePath;
		app.get(`${prefix}/attachments/:id/:variant/:filename`, requireApp('./plugins/nodebb-plugin-private-attachments/routes').createReadHandler({
			...services, attachments, setSafeFileHeaders: requireApp('./src/middleware/uploads').setSafeFileHeaders,
			documentPreview: requireApp('./plugins/nodebb-plugin-private-attachments/documents').createDocumentPreview(services),
		}));
		server = app.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const origin = `http://127.0.0.1:${server.address().port}`;
		const source = requireApp('./plugins/nodebb-plugin-private-attachments/attachments').attachmentUrl(prefix, id, 'original', record.name);
		const headers = { 'X-Test-Token': token, 'X-Test-Uid': String(uid) };
		const guestReadable = await lifecycle.canRead(record, 0);
		const guest = await fetch(`${origin}${source}`, { method: 'HEAD', headers: { ...headers, 'X-Test-Uid': '0' } });
		assert.equal(guest.status, guestReadable ? 200 : 404);
		const response = await fetch(`${origin}${source}?poster=1`, { headers });
		assert.equal(response.status, 200, await response.clone().text());
		assert.equal(response.headers.get('content-type'), 'image/png');
		const png = Buffer.from(await response.arrayBuffer());
		assert.equal(png.subarray(1, 4).toString(), 'PNG');
		const target = path.join(root, 'backups/document-preview');
		await fs.mkdir(target, { recursive: true });
		await fs.writeFile(path.join(target, `${id}.png`), png);
		const preview = await fetch(`${origin}${source}?preview=1`, { headers: { ...headers, Range: 'bytes=0-4' } });
		assert.equal(preview.status, 206);
		assert.equal(preview.headers.get('content-type'), 'application/pdf');
		assert.match(preview.headers.get('content-disposition'), /^inline/);
		assert.equal(await preview.text(), '%PDF-');
		const download = await fetch(`${origin}${source}?download=1`, { method: 'HEAD', headers });
		assert.match(download.headers.get('content-disposition'), /^attachment/);
		const latest = await db.getObject(`privateAttachment:${id}`);
		assert.deepEqual(JSON.parse(latest.variants).original, JSON.parse(original).original);
		const pid = record.pid;
		if (pid) {
			const data = { teasers: [{ pid }], uid: Number(uid) };
			await requireApp('./plugins/nodebb-plugin-private-attachments/summary-media').createSummaryMedia({ ...services, canRead: lifecycle.canRead })(data);
			assert.equal(data.teasers[0].mediaPreview?.isDocument, true);
		}
		console.log(JSON.stringify({ name: record.name, coverBytes: png.length, coverPath: path.join(target, `${id}.png`),
			checks: ['post permissions', 'first-page PNG', 'inline PDF range', 'original download', 'original unchanged'] }, null, 2));
	} finally {
		server?.closeAllConnections();
		server?.close();
		await db.close();
	}
}

main().then(() => process.exit(0)).catch(err => { console.error(err.message); process.exit(1); });
