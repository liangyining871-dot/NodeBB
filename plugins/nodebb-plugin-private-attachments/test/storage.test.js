'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Client } = require('minio');
const { readConfig, connect } = require('../storage');

const env = { MINIO_ENDPOINT: 'localhost', MINIO_ACCESS_KEY: 'example', MINIO_SECRET_KEY: ' secret ' };

test('配置默认值与可选区域，不修改密钥原文', () => {
	const { bucket, options } = readConfig(env);
	assert.equal(bucket, 'nodebb');
	assert.equal(options.port, 9000);
	assert.equal(options.useSSL, false);
	assert.equal(options.secretKey, env.MINIO_SECRET_KEY);
	assert.equal(Object.hasOwn(options, 'region'), false);
	assert.equal(readConfig({ ...env, MINIO_USE_SSL: 'true' }).options.port, 443);
});

test('无效配置被拒绝，错误不包含配置值', () => {
	for (const extra of [
		{ MINIO_ENDPOINT: 'https://sensitive.example' },
		{ MINIO_PORT: '65536' },
		{ MINIO_USE_SSL: 'yes' },
		{ MINIO_ACCESS_KEY: '' },
		{ MINIO_BUCKET: '../invalid' },
	]) {
		assert.throws(() => readConfig({ ...env, ...extra }), (err) => {
			assert.equal(err.message.includes('sensitive'), false);
			return true;
		});
	}
});

test('已有私有桶不重复创建', async (t) => {
	t.mock.method(Client.prototype, 'bucketExists', async () => true);
	t.mock.method(Client.prototype, 'getBucketPolicy', async () => {
		throw Object.assign(new Error('missing'), { code: 'NoSuchBucketPolicy' });
	});
	const create = t.mock.method(Client.prototype, 'makeBucket', async () => {});
	assert.equal((await connect(env)).bucket, 'nodebb');
	assert.equal(create.mock.callCount(), 0);
});

test('不存在的桶创建后检查策略', async (t) => {
	t.mock.method(Client.prototype, 'bucketExists', async () => false);
	const create = t.mock.method(Client.prototype, 'makeBucket', async () => {});
	t.mock.method(Client.prototype, 'getBucketPolicy', async () => '');
	await connect(env);
	assert.deepEqual(create.mock.calls[0].arguments, ['nodebb', undefined]);
});

test('已有桶策略拒绝使用，SDK 错误不泄露', async (t) => {
	t.mock.method(Client.prototype, 'bucketExists', async () => true);
	const policy = t.mock.method(Client.prototype, 'getBucketPolicy', async () => JSON.stringify({
		Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject' }],
	}));
	await assert.rejects(connect(env), /存在桶策略/);
	policy.mock.mockImplementation(async () => { throw new Error('sensitive credentials'); });
	await assert.rejects(connect(env), (err) => {
		assert.equal(err.message.includes('sensitive'), false);
		return /MinIO 检查失败/.test(err.message);
	});
});
