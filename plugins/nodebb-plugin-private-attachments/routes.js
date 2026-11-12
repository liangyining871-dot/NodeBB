'use strict';

const { pipeline } = require('node:stream/promises');

function createReadHandler({ attachments, getStorage, setSafeFileHeaders, inlineSvg = false }) {
	return async function read(req, res) {
		// 成功、错误、HEAD 和 Range 都禁止共享缓存，每次请求重新鉴权。
		res.set('Cache-Control', 'private, no-store');
		res.vary('Cookie').vary('Authorization');
		let stream;
		try {
			const { record, file } = await attachments.getReadable(req.params.id, req.uid, req.params.variant);
			const { client, bucket } = getStorage();
			const stat = await client.statObject(bucket, file.objectKey);
			const size = Number(stat.size);
			res.set('Accept-Ranges', 'bytes');
			let range;
			// HEAD 返回完整资源头；Range 只影响 GET。多段或格式错误的 Range 忽略。
			if (req.method === 'GET' && /^bytes=/i.test(req.headers.range || '') && !req.headers['if-range']) {
				const ranges = req.range(size);
				if (ranges === -1) {
					res.set('Content-Range', `bytes */${size}`);
					return res.status(416).end();
				}
				if (Array.isArray(ranges) && ranges.type === 'bytes' && ranges.length === 1) {
					[range] = ranges;
				}
			}
			if (req.method !== 'HEAD') {
				stream = range ? await client.getPartialObject(bucket, file.objectKey, range.start, range.end - range.start + 1) :
					await client.getObject(bucket, file.objectKey);
			}
			// 仅浏览器可安全展示的图片和常用视频内联，其余文件强制下载。
			const inline = /^(image\/(jpeg|png|gif|webp|avif|x-icon|vnd.microsoft.icon)|video\/(mp4|webm|ogg))$/.test(file.mime) ||
				(inlineSvg && file.mime === 'image/svg+xml');
			res.attachment(record.name);
			if (inline) {
				res.set('Content-Disposition', res.get('Content-Disposition').replace(/^attachment/, 'inline'));
			}
			setSafeFileHeaders(res, record.name);
			res.type(file.mime);
			res.set('Content-Security-Policy', "default-src 'none'; sandbox");
			res.set('Content-Length', String(range ? range.end - range.start + 1 : size));
			if (range) {
				res.status(206).set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
			}
			if (req.method === 'HEAD') {
				return res.end();
			}
			// 客户端关闭时 pipeline 销毁上游流，避免继续从 MinIO 下载。
			await pipeline(stream, res);
		} catch (err) {
			stream?.destroy();
			if (res.headersSent || res.destroyed) {
				res.destroy();
				return;
			}
			res.removeHeader('Content-Length');
			res.removeHeader('Content-Range');
			const status = err.status === 404 || ['NoSuchKey', 'NotFound'].includes(err.code) ? 404 : 503;
			res.status(status).json({ error: status === 404 ? '附件不存在或无权访问' : '附件读取失败，请稍后重试' });
		}
	};
}

module.exports = { createReadHandler };
