'use strict';

const { Client } = require('minio');
const { readConfig } = require('./storage');

function readDirectConfig(env = process.env) {
	const enabled = env.MINIO_DIRECT_UPLOAD_ENABLED === 'true';
	if (env.MINIO_DIRECT_UPLOAD_ENABLED && !['true', 'false'].includes(env.MINIO_DIRECT_UPLOAD_ENABLED)) {
		throw new Error('MINIO_DIRECT_UPLOAD_ENABLED 必须为 true 或 false');
	}
	const maxBytes = Number(env.MINIO_DIRECT_UPLOAD_MAX_BYTES || 2147483648);
	const partSize = Number(env.MINIO_DIRECT_UPLOAD_PART_SIZE_MB || 16) * 1024 * 1024;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2147483648 ||
		!Number.isSafeInteger(partSize) || partSize < 5 * 1024 * 1024 || partSize > 64 * 1024 * 1024) {
		throw new Error('直传大小配置无效，文件上限不超过 2 GiB，分片大小为 5–64 MiB');
	}
	let publicUrl;
	if (enabled) {
		try { publicUrl = new URL(env.MINIO_PUBLIC_URL); } catch (_err) { throw new Error('启用直传必须配置 MINIO_PUBLIC_URL'); }
		if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password ||
			publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
			throw new Error('MINIO_PUBLIC_URL 必须为浏览器可访问的 MinIO S3 根地址，不带路径或凭据');
		}
	}
	return { enabled, maxBytes, partSize, publicUrl: publicUrl?.origin, threshold: 16 * 1024 * 1024,
		concurrency: 3, expires: 900, taskTTL: 24 * 60 * 60 * 1000 };
}

// Multipart 方法由项目固定的 minio 8.0.7 提供，集中封装以便 SDK 升级时复核。
function createMultipartStorage({ getStorage, config, env = process.env }) {
	const { options } = readConfig(env);
	const address = new URL(config.publicUrl);
	const signer = new Client({ ...options, endPoint: address.hostname,
		port: Number(address.port || (address.protocol === 'https:' ? 443 : 80)),
		useSSL: address.protocol === 'https:', pathStyle: true });
	async function context() { return await getStorage(); }
	return {
		async create(key) {
			const { client, bucket } = await context();
			return await client.initiateNewMultipartUpload(bucket, key, { 'Content-Type': 'application/octet-stream' });
		},
		async sign(key, uploadId, partNumber) {
			const { client, bucket } = await context();
			// 使用内部地址获取真实区域，签名始终使用浏览器地址，不能签完后替换域名。
			signer.region = await client.getBucketRegionAsync(bucket);
			return await signer.presignedUrl('PUT', bucket, key, config.expires, { uploadId, partNumber });
		},
		async parts(key, uploadId) {
			const { client, bucket } = await context();
			return await client.listParts(bucket, key, uploadId);
		},
		async complete(key, uploadId, parts) {
			const { client, bucket } = await context();
			return await client.completeMultipartUpload(bucket, key, uploadId, parts);
		},
		async abort(key, uploadId) {
			const { client, bucket } = await context();
			try {
				if (uploadId) { await client.abortMultipartUpload(bucket, key, uploadId); } else {
					await client.removeIncompleteUpload(bucket, key);
				}
			} catch (err) {
				if (err.code !== 'NoSuchUpload') { throw err; }
			}
		},
		async stat(key) { const { client, bucket } = await context(); return await client.statObject(bucket, key); },
		async prefix(key) {
			const { client, bucket } = await context();
			const stream = await client.getPartialObject(bucket, key, 0, 1024 * 1024);
			const chunks = [];
			for await (const chunk of stream) { chunks.push(chunk); }
			return Buffer.concat(chunks);
		},
		async remove(key) { const { client, bucket } = await context(); await client.removeObject(bucket, key); },
	};
}

module.exports = { readDirectConfig, createMultipartStorage };
