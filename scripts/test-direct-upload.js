'use strict';

// 独立回环测试服务；使用真实数据库和 MinIO，结束后仅删除本次创建的随机附件。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const requireApp = require('node:module').createRequire(path.join(root, 'package.json'));
const run = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
	const size = Number(process.argv.find(arg => arg.startsWith('--size='))?.split('=')[1] || 48 * 1024 * 1024);
	assert.ok(Number.isSafeInteger(size) && size >= 32 * 1024 * 1024 && size <= 2147483648);
	requireApp('./require-main');
	requireApp('./nodebb-global');
	const nconf = requireApp('nconf');
	nconf.env({ separator: '__' });
	requireApp('./src/prestart').loadConfig(path.join(root, 'config.json'));
	const winston = requireApp('winston');
	winston.configure({ silent: true, transports: [new winston.transports.Console()] });
	const db = requireApp('./src/database');
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nodebb-direct-check-'));
	let server;
	let chrome;
	let socket;
	let storage;
	let service;
	const created = new Set();
	let uid;
	try {
		await db.init();
		const meta = requireApp('./src/meta');
		await meta.configs.init();
		[uid] = await db.getSortedSetRange('group:administrators:members', 0, 0);
		assert.ok(uid, '需要已有管理员执行本地集成检查');
		uid = Number(uid);
		const { readDirectConfig, createMultipartStorage } = requireApp('./plugins/nodebb-plugin-private-attachments/multipart-storage');
		const config = readDirectConfig();
		assert.ok(config.enabled, '请先启用本地直传配置');
		storage = await requireApp('./plugins/nodebb-plugin-private-attachments/storage').connect();
		const file = requireApp('./src/file');
		const services = { db, privileges: requireApp('./src/privileges'), getStorage: () => storage,
			relativePath: '', config, detectBuffer: requireApp('file-type').fileTypeFromBuffer,
			allowedExtensions: file.allowedExtensions, blockedExtensions: file.blockedExtensions };
		service = requireApp('./plugins/nodebb-plugin-private-attachments/direct-uploads').createDirectUploads({ ...services,
			db: { ...db, async setObject(key, value) {
				if (key.startsWith('privateMultipart:')) { created.add(value.id); }
				await db.setObject(key, value);
			} }, storage: createMultipartStorage(services) });
		const token = randomUUID();
		const app = requireApp('express')();
		app.use(requireApp('express').json({ limit: '16kb' }));
		let metadataBytes = 0;
		app.use((req, res, next) => {
			req.uid = uid;
			if (req.method === 'POST') { metadataBytes += Buffer.byteLength(JSON.stringify(req.body || {})); }
			next();
		});
		const middleware = { authenticateRequest: (req, res, next) => next(), ensureLoggedIn: (req, res, next) => next(),
			redirectToHomeIfBanned: (req, res, next) => next(),
			applyCSRF(req, res, next) { if (req.get('x-csrf-token') !== token) { return res.sendStatus(403); } next(); } };
		requireApp('./plugins/nodebb-plugin-private-attachments/direct-uploads').registerDirectUploadRoutes({ router: app, middleware, service });
		const attachments = requireApp('./plugins/nodebb-plugin-private-attachments/attachments').createAttachments(services);
		app.get('/attachments/:id/:variant/:filename', requireApp('./plugins/nodebb-plugin-private-attachments/routes').createReadHandler({
			...services, attachments, setSafeFileHeaders: res => res.set('X-Content-Type-Options', 'nosniff') }));
		app.get('/direct-upload.js', (req, res) => res.sendFile(path.join(root, 'plugins/nodebb-plugin-private-attachments/static/direct-upload.js')));
		const samplePath = path.join(directory, 'sample.mp4');
		await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10',
			'-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', samplePath], { timeout: 30000, windowsHide: true });
		const sample = await fs.readFile(samplePath);
		const freeHeader = Buffer.alloc(8);
		freeHeader.writeUInt32BE(size - sample.length);
		freeHeader.write('free', 4);
		const prefix = Buffer.concat([sample, freeHeader]);
		app.get('/', (req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Direct upload check</title>
<script>window.config={relative_path:'',csrf_token:${JSON.stringify(token)}};window.define=(name,deps,factory)=>window.direct=factory();window.state={status:'ready'};</script>
<script src="/direct-upload.js"></script><script>
window.startUpload=async()=>{try{
 const prefix=Uint8Array.from(atob('${prefix.toString('base64')}'),c=>c.charCodeAt(0));
 const chunkSize=${config.partSize};const zero=new Blob([new Uint8Array(chunkSize)]);
 const pieces=[new Blob([prefix,new Uint8Array(chunkSize-prefix.length)])];
 let remaining=${size}-chunkSize;while(remaining>0){pieces.push(zero.slice(0,Math.min(chunkSize,remaining)));remaining-=Math.min(chunkSize,remaining);}
 const file=new File(pieces,'direct-check.mp4',{type:'video/mp4'});state={status:'uploading',loaded:0};
 const result=await direct.uploadFile(file,{onProgress:bytes=>state.loaded=bytes});
 state={status:'done',result,size:file.size};const video=document.createElement('video');video.muted=true;video.controls=true;
 video.onloadedmetadata=()=>{state.duration=video.duration;state.videoWidth=video.videoWidth;};video.onerror=()=>state.videoError=video.error?.message;
 video.src=result.url;document.body.append(video);
}catch(error){state={status:'error',error:error.message};}};
</script>`));
		server = app.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const origin = `http://127.0.0.1:${server.address().port}`;
		const denied = await fetch(`${origin}/api/private-attachments/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
		assert.equal(denied.status, 403, '创建任务必须校验 CSRF');
		const profile = path.join(directory, 'chrome');
		chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
			'--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
			`--user-data-dir=${profile}`, 'about:blank',
		], { windowsHide: true, stdio: 'ignore' });
		let debugPort;
		for (let i = 0; i < 80; i++) {
			try { debugPort = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch (_err) { await sleep(250); }
		}
		assert.ok(debugPort, 'Chrome 未启动');
		const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(origin)}`, { method: 'PUT' })).json();
		socket = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
		let callId = 0;
		const pending = new Map();
		const call = (method, params) => new Promise(resolve => {
			const id = ++callId; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params }));
		});
		let injected = false;
		let putCount = 0;
		socket.onmessage = event => {
			const data = JSON.parse(event.data);
			if (data.id) { pending.get(data.id)?.(data); pending.delete(data.id); }
			if (data.method === 'Fetch.requestPaused') {
				const { requestId, request } = data.params;
				if (request.method === 'PUT') { putCount += 1; }
				if (!injected && request.method === 'PUT') {
					injected = true;
					void call('Fetch.failRequest', { requestId, errorReason: 'ConnectionReset' });
				} else { void call('Fetch.continueRequest', { requestId }); }
			}
		};
		await call('Fetch.enable', { patterns: [{ urlPattern: `${config.publicUrl}/*`, requestStage: 'Request' }] });
		for (let i = 0; i < 40; i++) {
			const ready = await call('Runtime.evaluate', { expression: 'typeof startUpload', returnByValue: true });
			if (ready.result?.result?.value === 'function') { break; }
			await sleep(250);
		}
		await call('Runtime.evaluate', { expression: 'void startUpload()' });
		let state;
		let lastProgress = -1;
		for (let i = 0; i < 1200; i++) {
			const result = await call('Runtime.evaluate', { expression: 'window.state', returnByValue: true });
			state = result.result?.result?.value;
			if (state?.status === 'error') { throw new Error(state.error); }
			const progress = Math.floor((state?.loaded || 0) / size * 4);
			if (progress > lastProgress) { lastProgress = progress; console.log(`浏览器直传进度：${Math.min(100, progress * 25)}%`); }
			if (state?.status === 'done' && state.duration > 0) { break; }
			if (state?.videoError) { throw new Error(state.videoError); }
			await sleep(500);
		}
		assert.equal(state?.status, 'done');
		assert.ok(state.duration > 0 && state.videoWidth > 0, '上传后视频不可播放');
		assert.ok(injected && putCount > Math.ceil(size / config.partSize), '失败分片未重试');
		assert.ok(metadataBytes < 64 * 1024, '论坛接收了过多上传数据');
		const record = await db.getObject(`privateAttachment:${state.result.attachmentId}`);
		const actual = createHash('sha256');
		for await (const chunk of await storage.client.getObject(storage.bucket, record.objectKey)) { actual.update(chunk); }
		const expected = createHash('sha256');
		expected.update(prefix);
		const zeros = Buffer.alloc(config.partSize);
		for (let left = size - prefix.length; left > 0; left -= Math.min(left, zeros.length)) { expected.update(zeros.subarray(0, Math.min(left, zeros.length))); }
		assert.equal(actual.digest('hex'), expected.digest('hex'), '最终对象内容校验失败');
		const cancelled = await service.create(uid, { name: 'cancel.mp4', size: 32 * 1024 * 1024 });
		await service.cancel(uid, cancelled.id);
		const result = { bytes: size, parts: Math.ceil(size / config.partSize), putRequests: putCount,
			metadataBytes, videoDuration: state.duration, checks: ['browser CORS', 'injected network failure and retry',
				'complete and type detection', 'authenticated video playback', 'SHA-256 integrity', 'cancel cleanup'] };
		await fs.mkdir(path.join(root, 'backups/direct-upload-test'), { recursive: true });
		await fs.writeFile(path.join(root, 'backups/direct-upload-test/result.json'), JSON.stringify(result, null, 2));
		console.log(JSON.stringify(result, null, 2));
	} finally {
		socket?.close();
		chrome?.kill();
		server?.closeAllConnections(); server?.close();
		for (const id of created) {
			try {
				const task = await db.getObject(`privateMultipart:${id}`);
				if (task && storage) {
					try { await storage.client.abortMultipartUpload(storage.bucket, task.objectKey, task.uploadId); } catch (_err) { /* 完成的任务不再有 uploadId。 */ }
					await storage.client.removeObject(storage.bucket, task.objectKey);
				}
				await db.delete(`privateMultipart:${id}`);
				await db.delete(`privateAttachment:${id}`);
				await db.setRemove(`privateMultipart:user:${uid}`, id);
				await db.setRemove('privateMultipart:active', id);
				await db.sortedSetRemove('privateMultipart:expiry', id);
			} catch (_err) { console.error(`请检查本次测试任务的清理：${id}`); }
		}
		await db.close();
		await sleep(500);
		const resolved = path.resolve(directory);
		if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('nodebb-direct-check-')) {
			await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
		}
	}
}

main().then(() => process.exit(0)).catch(err => { console.error(err.message); process.exit(1); });
