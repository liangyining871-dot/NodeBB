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

// 从片头的一组帧中选代表画面，避免直接把第一帧黑屏作为封面。
async function extractPoster(input, output) {
	await run(process.env.FFMPEG_PATH || 'ffmpeg', [
		'-nostdin', '-y', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', input,
		'-map', '0:v:0', '-frames:v', '1', '-vf', 'thumbnail=60,scale=640:-2', '-q:v', '3', '-threads', '2', output,
	], { timeout: 60 * 1000, maxBuffer: 1024 * 1024, windowsHide: true });
}

function createVideoPreview({ db, getStorage, convert = convertVideo, poster = extractPoster }) {
	let queue = Promise.resolve();
	const pending = new Map();
	return function preview(record, variant = 'preview') {
		if (!['preview', 'poster'].includes(variant)) { throw new Error('无效的视频变体'); }
		const taskKey = `${record.id}:${variant}`;
		// 同一附件共享任务，所有转换串行执行，避免同时启动大量 FFmpeg。
		if (pending.has(taskKey)) { return pending.get(taskKey); }
		const task = queue.then(async () => {
			const key = `privateAttachment:${record.id}`;
			const current = await db.getObject(key);
			if (!current || !['pending', 'attached'].includes(current.status)) { throw new Error('附件不可用'); }
			const variants = JSON.parse(current.variants);
			const isPoster = variant === 'poster';
			// 旧封面可能是第一帧黑屏，更新算法后按需重新生成。
			if (variants[variant] && (!isPoster || variants[variant].version === 2)) { return variants[variant]; }
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nodebb-video-'));
			const { client, bucket } = getStorage();
			const filename = isPoster ? 'poster-v2.jpg' : 'preview.mp4';
			const file = { objectKey: `${record.id}/${filename}`, mime: isPoster ? 'image/jpeg' : 'video/mp4' };
			if (isPoster) { file.version = 2; }
			try {
				const input = path.join(dir, 'original');
				const output = path.join(dir, filename);
				await pipeline(await client.getObject(bucket, variants.original.objectKey), createWriteStream(input));
				await (isPoster ? poster : convert)(input, output);
				file.size = (await fs.stat(output)).size;
				await client.fPutObject(bucket, file.objectKey, output, { 'Content-Type': file.mime });
				// 转换期间帖子可能被删除，禁止重新创建已删除的附件记录。
				const latest = await db.getObject(key);
				if (!latest || !['pending', 'attached'].includes(latest.status)) {
					await client.removeObject(bucket, file.objectKey);
					throw new Error('附件不可用');
				}
				await db.setObjectField(key, 'variants', JSON.stringify({ ...JSON.parse(latest.variants), [variant]: file }));
				// 记录切换成功后清理旧算法的封面，清理失败不影响当前预览。
				if (isPoster && variants.poster && variants.poster.objectKey !== file.objectKey) {
					await client.removeObject(bucket, variants.poster.objectKey).catch(() => {});
				}
				return file;
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		});
		queue = task.catch(() => {});
		pending.set(taskKey, task);
		return task.finally(() => pending.delete(taskKey));
	};
}

module.exports = { createVideoPreview, convertVideo, extractPoster };
