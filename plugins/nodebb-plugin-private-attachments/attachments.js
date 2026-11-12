'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const error = (status, message) => Object.assign(new Error(message), { status });
const recordKey = id => `privateAttachment:${id}`;
const attachmentUrl = (prefix, id, variant, name) => {
	const filename = encodeURIComponent(name).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
	return `${prefix}/attachments/${id}/${variant}/${filename}`;
};

function createAttachments({ db, image, meta, privileges, getStorage, canRead, relativePath = '' }) {
	const url = (id, variant, name) => attachmentUrl(relativePath, id, variant, name);

	async function upload({ file, uid, detected, thumbnail = false }) {
		const isImage = Boolean(detected?.mime.startsWith('image/'));
		const privilege = isImage ? 'upload:post:image' : 'upload:post:file';
		if (!(uid > 0) || !await privileges.global.can(privilege, uid)) {
			throw error(403, '[[error:no-privileges]]');
		}
		const stat = await fs.stat(file.path);
		if (!stat.size || stat.size > Number(meta.config.maximumFileSize) * 1024) {
			throw error(400, '附件为空或超过上传大小限制');
		}
		const storage = getStorage();
		const id = randomUUID();
		const name = path.basename((file.name || 'file').replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 255) || 'file';
		// MIME 使用实际检测结果，未知类型按二进制文件下载，不信任浏览器声明。
		const mime = detected?.mime || 'application/octet-stream';
		const extension = detected?.ext || path.extname(name).slice(1).toLowerCase();
		const suffix = /^[a-z0-9]{1,16}$/.test(extension) ? `.${extension}` : '';
		let tempDir;
		let record;
		try {
			let dimensions = {};
			const variants = {};
			if (isImage) {
				try {
					await image.isFileTypeAllowed(file.path);
					dimensions = await image.checkDimensions(file.path);
				} catch (_err) {
					throw error(400, '图片格式或尺寸不符合上传要求');
				}
				await image.stripEXIF({ path: file.path, type: mime });
				dimensions = await image.size(file.path);
				const width = Number(thumbnail ? meta.config.topicThumbSize : meta.config.resizeImageWidth);
				const threshold = thumbnail ? width : Number(meta.config.resizeImageWidthThreshold);
				if (mime !== 'image/svg+xml' && width > 0 && threshold > 0 && dimensions.width > Math.max(width, threshold)) {
					tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nodebb-attachment-'));
					const target = path.join(tempDir, `thumbnail${suffix}`);
					await image.resizeImage({ path: file.path, target, width, type: mime, quality: meta.config.resizeImageQuality });
					variants.thumbnail = { objectKey: `${id}/thumbnail${suffix}`, size: (await fs.stat(target)).size, mime };
				}
			}
			// 图片处理后再计算大小和校验值，确保元数据对应实际存储的字节。
			const hash = createHash('sha256');
			for await (const chunk of createReadStream(file.path)) {
				hash.update(chunk);
			}
			const original = { objectKey: `${id}/original${suffix}`, size: (await fs.stat(file.path)).size, mime };
			variants.original = original;
			record = {
				id, uploaderUid: Number(uid), name, mime, size: original.size, objectKey: original.objectKey,
				sha256: hash.digest('hex'), createdAt: Date.now(), status: 'uploading',
				...dimensions, variants: JSON.stringify(variants),
			};
			await db.setObject(recordKey(id), record);
			await storage.client.fPutObject(storage.bucket, original.objectKey, file.path, { 'Content-Type': mime });
			if (variants.thumbnail) {
				await storage.client.fPutObject(storage.bucket, variants.thumbnail.objectKey, path.join(tempDir, `thumbnail${suffix}`), { 'Content-Type': mime });
			}
			// 对象全部写入后才可读；关联帖子前仅上传者可访问。
			await db.setObjectField(recordKey(id), 'status', 'pending');
			return {
				attachmentId: id, name,
				url: url(id, variants.thumbnail ? 'thumbnail' : 'original', name),
				originalUrl: url(id, 'original', name),
				...(variants.thumbnail ? { thumbnailUrl: url(id, 'thumbnail', name) } : {}),
			};
		} catch (_err) {
			if (record) {
				// 保留失败状态，供后续一致性检查使用；本版不做废弃对象自动清理。
				await db.setObjectField(recordKey(id), 'status', 'failed').catch(() => {});
			}
			throw _err.status === 400 ? _err : error(503, '附件保存失败，请稍后重试');
		} finally {
			if (tempDir) {
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		}
	}

	async function getReadable(id, uid, variant) {
		if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) || !['original', 'thumbnail'].includes(variant)) {
			throw error(404, '附件不存在');
		}
		const record = await db.getObject(recordKey(id));
		const readable = record && (canRead ? await canRead(record, uid) :
			record.status === 'pending' && uid > 0 && Number(record.uploaderUid) === Number(uid));
		if (!readable) {
			throw error(404, '附件不存在或无权访问');
		}
		const file = JSON.parse(record.variants)[variant];
		if (!file) {
			throw error(404, '附件不存在');
		}
		return { record, file };
	}

	return { upload, getReadable };
}

module.exports = { createAttachments, attachmentUrl };
