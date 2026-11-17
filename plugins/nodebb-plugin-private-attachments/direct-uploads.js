'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { attachmentUrl } = require('./attachments');

const videoExtensions = new Set(['mp4', 'wmv', 'webm', 'ogg']);
const error = (status, message) => Object.assign(new Error(message), { status });
const taskKey = id => `privateMultipart:${id}`;
const expiryKey = 'privateMultipart:expiry';
const activeKey = uid => `privateMultipart:user:${uid}`;
const globalActiveKey = 'privateMultipart:active';

function createDirectUploads({ db, privileges, config, storage, detectBuffer, allowedExtensions,
	blockedExtensions, relativePath = '', now = Date.now }) {
	const locks = new Map();
	function exclusive(id, callback) {
		const task = (locks.get(id) || Promise.resolve()).catch(() => {}).then(callback);
		const held = task.finally(() => { if (locks.get(id) === held) { locks.delete(id); } });
		locks.set(id, held);
		// Store a handled promise; callers still receive the original rejection.
		held.catch(() => {});
		return held;
	}
	async function permission(uid) {
		if (!config.enabled) { throw error(404, '直传未启用'); }
		if (!(uid > 0) || !await privileges.global.can('upload:post:file', uid)) { throw error(403, '没有上传权限'); }
	}
	function validateExtension(extension) {
		const ext = `.${extension}`;
		const allowed = allowedExtensions();
		if ((allowed.length && !allowed.includes(ext)) || blockedExtensions().includes(ext)) {
			throw error(400, '文件类型不允许上传');
		}
	}
	async function owned(id, uid, { expired = false } = {}) {
		if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id || '')) { throw error(404, '上传任务不存在'); }
		const task = await db.getObject(taskKey(id));
		if (!task || Number(task.uid) !== Number(uid)) { throw error(404, '上传任务不存在'); }
		if (!expired && Number(task.expiresAt) <= now()) { throw error(410, '上传任务已过期，请重新选择文件'); }
		return task;
	}
	async function untrack(task) {
		await db.setRemove(activeKey(task.uid), task.id);
		await db.setRemove(globalActiveKey, task.id);
	}
	function result(task) {
		return { attachmentId: task.id, name: task.name,
			url: attachmentUrl(relativePath, task.id, 'original', task.name) };
	}
	async function create(uid, input) {
		await permission(uid);
		const name = path.basename(String(input.name || '').replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '');
		const extension = path.extname(name).slice(1).toLowerCase();
		const size = Number(input.size);
		if (!name || name.length > 255 || !videoExtensions.has(extension)) { throw error(400, '直传仅支持 MP4、WMV、WebM、OGG 视频'); }
		if (!Number.isSafeInteger(size) || size < 1 || size > config.maxBytes) { throw error(413, '视频为空或超过直传大小限制'); }
		validateExtension(extension);
		return exclusive('create', async () => {
			if ((await db.getSetMembers(activeKey(uid))).length >= 3 || (await db.getSetMembers(globalActiveKey)).length >= 100) {
				throw error(429, '上传任务较多，请完成或取消已有任务后重试');
			}
			const id = randomUUID();
			const task = { id, uid: Number(uid), name, size, extension, objectKey: `${id}/original.${extension}`,
				partSize: config.partSize, createdAt: now(), expiresAt: now() + config.taskTTL, state: 'creating' };
			await db.setObject(taskKey(id), task);
			await db.sortedSetAdd(expiryKey, task.expiresAt, id);
			await db.setAdd(activeKey(uid), id);
			await db.setAdd(globalActiveKey, id);
			try {
				task.uploadId = await storage.create(task.objectKey);
				task.state = 'uploading';
				await db.setObject(taskKey(id), task);
				return { id, size, partSize: config.partSize, partCount: Math.ceil(size / config.partSize),
					expiresAt: task.expiresAt, concurrency: config.concurrency };
			} catch (err) {
				await storage.abort(task.objectKey, task.uploadId).catch(() => {});
				await db.setObjectField(taskKey(id), 'state', 'failed');
				await untrack(task);
				throw err;
			}
		});
	}
	async function sign(uid, id, partNumber) {
		await permission(uid);
		const task = await owned(id, uid);
		if (task.state !== 'uploading') { throw error(409, '上传任务当前不可写入'); }
		const part = Number(partNumber);
		if (!Number.isInteger(part) || part < 1 || part > Math.ceil(Number(task.size) / Number(task.partSize))) {
			throw error(400, '分片编号无效');
		}
		return { url: await storage.sign(task.objectKey, task.uploadId, part), expiresIn: config.expires };
	}
	async function rejectFile(task, message) {
		await storage.remove(task.objectKey);
		await db.setObjectField(taskKey(task.id), 'state', 'failed');
		await untrack(task);
		throw error(400, message);
	}
	async function complete(uid, id) {
		await permission(uid);
		return exclusive(id, async () => {
			const task = await owned(id, uid);
			if (task.state === 'complete') { await untrack(task); return result(task); }
			if (!['uploading', 'completing'].includes(task.state)) { throw error(409, '上传任务当前不可完成'); }
			validateExtension(task.extension);
			if (task.state === 'uploading') {
				const parts = (await storage.parts(task.objectKey, task.uploadId)).sort((a, b) => a.part - b.part);
				const count = Math.ceil(Number(task.size) / Number(task.partSize));
				if (parts.length !== count || parts.some((part, index) => Number(part.part) !== index + 1 ||
					Number(part.size) !== Math.min(Number(task.partSize), Number(task.size) - index * Number(task.partSize)))) {
					throw error(400, '分片未传齐或实际大小不匹配，请重新上传');
				}
				await db.setObjectField(taskKey(id), 'state', 'completing');
				await storage.complete(task.objectKey, task.uploadId, parts.map(part => ({ part: part.part, etag: part.etag })));
			}
			// Complete 响应丢失、进程重启或落库失败时，可根据实际对象重新验证并完成登记。
			let stat;
			try { stat = await storage.stat(task.objectKey); } catch (err) {
				if (['NotFound', 'NoSuchKey'].includes(err.code)) { await db.setObjectField(taskKey(id), 'state', 'uploading'); }
				throw err;
			}
			if (Number(stat.size) !== Number(task.size) || Number(stat.size) > config.maxBytes) {
				return await rejectFile(task, '视频实际大小不符合限制');
			}
			let detected;
			try { detected = await detectBuffer(await storage.prefix(task.objectKey)); } catch (_err) {
				return await rejectFile(task, '无法识别视频文件');
			}
			const mimeTypes = { mp4: ['video/mp4'], webm: ['video/webm'], ogg: ['video/ogg'],
				wmv: ['video/x-ms-asf', 'video/x-ms-wmv', 'application/vnd.ms-asf'] };
			if (!detected || !mimeTypes[task.extension].includes(detected.mime)) { return await rejectFile(task, '实际文件类型不是所选格式的视频'); }
			if (detected.ext && blockedExtensions().includes(`.${detected.ext}`)) { return await rejectFile(task, '实际文件类型被禁止'); }
			const mime = task.extension === 'wmv' ? 'video/x-ms-wmv' : detected.mime;
			const original = { objectKey: task.objectKey, size: Number(stat.size), mime };
			// 完成请求可重试，但不能覆盖已经关联帖子或生成封面的附件记录。
			const existing = await db.getObject(`privateAttachment:${id}`);
			if (!existing) {
				await db.setObject(`privateAttachment:${id}`, { id, uploaderUid: Number(uid), name: task.name, mime,
					size: Number(stat.size), objectKey: task.objectKey, objectETag: stat.etag || '', sha256: '',
					createdAt: Number(task.createdAt), status: 'pending', variants: JSON.stringify({ original }) });
			}
			await db.setObjectField(taskKey(id), 'state', 'complete');
			await untrack(task);
			return result(task);
		});
	}
	async function cancelTask(task) {
		if (task.state === 'complete') { await untrack(task); return; }
		if (await db.getObject(`privateAttachment:${task.id}`)) {
			await db.setObjectField(taskKey(task.id), 'state', 'complete');
			await untrack(task);
			return;
		}
		await storage.abort(task.objectKey, task.uploadId);
		await storage.remove(task.objectKey);
		await db.setObjectField(taskKey(task.id), 'state', 'cancelled');
		await untrack(task);
	}
	async function cancel(uid, id) {
		return exclusive(id, async () => { await cancelTask(await owned(id, uid, { expired: true })); });
	}
	async function cleanup() {
		const ids = await db.getSortedSetRangeByScore(expiryKey, 0, 100, '-inf', now());
		for (const id of ids) {
			await exclusive(id, async () => {
				const task = await db.getObject(taskKey(id));
				if (task) {
					// 落库成功但上传任务状态未更新时，不清理已登记的附件。
					if (!await db.getObject(`privateAttachment:${id}`)) { await cancelTask(task); }
					await untrack(task);
				}
				await db.delete(taskKey(id));
				await db.sortedSetRemove(expiryKey, id);
			});
		}
	}
	return { create, sign, complete, cancel, cleanup };
}

function registerDirectUploadRoutes({ router, middleware, service }) {
	const guards = [middleware.authenticateRequest, middleware.ensureLoggedIn, middleware.redirectToHomeIfBanned, middleware.applyCSRF];
	function handle(callback) {
		return async (req, res) => {
			res.set('Cache-Control', 'private, no-store');
			try { res.json(await callback(req)); } catch (err) {
				const status = [400, 403, 404, 409, 410, 413, 429].includes(err.status) ? err.status : 503;
				res.status(status).json({ error: status === 503 ? '上传服务暂不可用，请稍后重试' : err.message });
			}
		};
	}
	router.post('/api/private-attachments/uploads', ...guards, handle(req => service.create(req.uid, req.body || {})));
	router.post('/api/private-attachments/uploads/:id/part', ...guards, handle(req => service.sign(req.uid, req.params.id, req.body?.partNumber)));
	router.post('/api/private-attachments/uploads/:id/complete', ...guards, handle(req => service.complete(req.uid, req.params.id)));
	router.post('/api/private-attachments/uploads/:id/cancel', ...guards, handle(async req => {
		await service.cancel(req.uid, req.params.id);
		return { cancelled: true };
	}));
}

module.exports = { createDirectUploads, registerDirectUploadRoutes };
