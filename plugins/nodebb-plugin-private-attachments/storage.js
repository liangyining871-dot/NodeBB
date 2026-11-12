'use strict';

const { Client } = require('minio');

function readConfig(env = process.env) {
	const get = name => (env[`MINIO_${name}`] || '').trim();
	for (const name of ['ENDPOINT', 'ACCESS_KEY', 'SECRET_KEY']) {
		if (!get(name)) {
			throw new Error(`缺少 MINIO_${name} 配置`);
		}
	}
	const useSSL = get('USE_SSL') || 'false';
	const port = Number(get('PORT') || (useSSL === 'true' ? 443 : 9000));
	if (!['true', 'false'].includes(useSSL)) {
		throw new Error('MINIO_USE_SSL 必须为 true 或 false');
	}
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error('MINIO_PORT 必须为有效端口');
	}
	// 地址只接受主机名或 IP；错误信息不包含配置值，避免泄露凭证。
	if (/[\s/:?#@]/.test(get('ENDPOINT'))) {
		throw new Error('MINIO_ENDPOINT 只填写主机名或 IPv4 地址，不含协议、端口或路径');
	}
	const bucket = get('BUCKET') || 'nodebb';
	if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
		throw new Error('MINIO_BUCKET 格式不正确');
	}
	return {
		bucket,
		options: {
			endPoint: get('ENDPOINT'), port, useSSL: useSSL === 'true',
			accessKey: get('ACCESS_KEY'), secretKey: env.MINIO_SECRET_KEY,
			...(get('REGION') ? { region: get('REGION') } : {}),
		},
	};
}

async function connect(env = process.env) {
	const { bucket, options } = readConfig(env);
	const client = new Client(options);
	client.setRequestOptions({ timeout: 10000 });
	try {
		if (!await client.bucketExists(bucket)) {
			// 新桶默认私有，不写入任何公开策略。
			await client.makeBucket(bucket, options.region);
		}
		let policy;
		try {
			policy = await client.getBucketPolicy(bucket);
		} catch (err) {
			if (err.code !== 'NoSuchBucketPolicy') {
				throw err;
			}
		}
		// 首版要求专用桶无桶策略，避免继承已有公开授权；不自动修改现有策略。
		if (policy && Object.keys(JSON.parse(policy)).length) {
			throw new Error('BUCKET_POLICY_PRESENT');
		}
	} catch (err) {
		// SDK 错误可能带请求信息，禁止将原始错误或配置写入日志。
		if (err.message === 'BUCKET_POLICY_PRESENT') {
			throw new Error('附件桶存在桶策略，请确认并移除桶策略后重试');
		}
		throw new Error('MinIO 检查失败，请检查网络、凭证、区域及桶检查/创建权限');
	}
	return { client, bucket };
}

module.exports = { readConfig, connect };
