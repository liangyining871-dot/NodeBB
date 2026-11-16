'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { createWriteStream } = require('node:fs');

const run = promisify(execFile);

// 浏览器不能直接播放 WMV，生成 H.264/AAC MP4；原文件保留用于下载。
async function convertVideo(input, output) {
	await run(process.env.FFMPEG_PATH || 'ffmpeg', [
		'-nostdin', '-y', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', input,
		'-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'fast',
		'-crf', '23', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
		'-c:a', 'aac', '-movflags', '+faststart', '-threads', '2', output,
	], { timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024, windowsHide: true });
}

function createVideoPreview({ db, getStorage, convert = convertVideo }) {
	let queue = Promise.resolve();
	const pending = new Map();
	return function preview(record) {
		// 同一附件共享任务，所有转换串行执行，避免同时启动大量 FFmpeg。
		if (pending.has(record.id)) { return pending.get(record.id); }
		const task = queue.then(async () => {
			const key = `privateAttachment:${record.id}`;
			const current = await db.getObject(key);
			if (!current || !['pending', 'attached'].includes(current.status)) { throw new Error('附件不可用'); }
			const variants = JSON.parse(current.variants);
			if (variants.preview) { return variants.preview; }
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nodebb-video-'));
			const { client, bucket } = getStorage();
			const file = { objectKey: `${record.id}/preview.mp4`, mime: 'video/mp4' };
			try {
				const input = path.join(dir, 'original.wmv');
				const output = path.join(dir, 'preview.mp4');
				await pipeline(await client.getObject(bucket, variants.original.objectKey), createWriteStream(input));
				await convert(input, output);
				file.size = (await fs.stat(output)).size;
				await client.fPutObject(bucket, file.objectKey, output, { 'Content-Type': file.mime });
				// 转换期间帖子可能被删除，禁止重新创建已删除的附件记录。
				const latest = await db.getObject(key);
				if (!latest || !['pending', 'attached'].includes(latest.status)) {
					await client.removeObject(bucket, file.objectKey);
					throw new Error('附件不可用');
				}
				await db.setObjectField(key, 'variants', JSON.stringify({ ...JSON.parse(latest.variants), preview: file }));
				return file;
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		});
		queue = task.catch(() => {});
		pending.set(record.id, task);
		return task.finally(() => pending.delete(record.id));
	};
}

module.exports = { createVideoPreview, convertVideo };
