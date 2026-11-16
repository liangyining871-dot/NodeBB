'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { Readable } = require('node:stream');
const { createVideoPreview } = require('../video');

function fixture(convert, poster) {
	const record = { id: 'video', status: 'attached', variants: JSON.stringify({ original: { objectKey: 'video/original.wmv' } }) };
	const objects = new Map();
	const db = {
		async getObject() { return record; },
		async setObjectField(key, field, value) { record[field] = value; },
	};
	const client = {
		async getObject() { return Readable.from('wmv'); },
		async fPutObject(bucket, key, source) { objects.set(key, await fs.readFile(source)); },
		async removeObject(bucket, key) { objects.delete(key); },
	};
	return { record, objects, preview: createVideoPreview({ db, getStorage: () => ({ client, bucket: 'private' }), convert, poster }) };
}

test('封面单独生成并缓存，和播放变体共存且不覆盖原件', async () => {
	let calls = 0;
	const f = fixture(async (input, output) => fs.writeFile(output, 'mp4'), async (input, output) => {
		calls += 1;
		await fs.writeFile(output, 'jpeg');
	});
	const [poster, preview] = await Promise.all([f.preview(f.record, 'poster'), f.preview(f.record)]);
	assert.equal(poster.mime, 'image/jpeg');
	assert.equal(preview.mime, 'video/mp4');
	assert.deepEqual(await f.preview(f.record, 'poster'), poster);
	assert.equal(calls, 1);
	const variants = JSON.parse(f.record.variants);
	assert.equal(variants.original.objectKey, 'video/original.wmv');
	assert.equal(variants.poster.objectKey, 'video/poster-v2.jpg');
	assert.equal(variants.poster.version, 2);
	assert.equal(variants.preview.objectKey, 'video/preview.mp4');
});

test('WMV 合并并发转换、复用 MP4，保留原件', async () => {
	let calls = 0;
	const f = fixture(async (input, output) => {
		calls += 1;
		assert.equal(await fs.readFile(input, 'utf8'), 'wmv');
		await fs.writeFile(output, 'mp4');
	});
	const results = await Promise.all([f.preview(f.record), f.preview(f.record)]);
	assert.deepEqual(results[0], results[1]);
	assert.equal((await f.preview(f.record)).mime, 'video/mp4');
	assert.equal(calls, 1);
	assert.equal(JSON.parse(f.record.variants).original.objectKey, 'video/original.wmv');
});

test('旧黑屏封面按新算法重建，后续直接复用', async () => {
	let calls = 0;
	const f = fixture(undefined, async (input, output) => { calls += 1; await fs.writeFile(output, 'new-poster'); });
	const variants = JSON.parse(f.record.variants);
	f.record.variants = JSON.stringify({ ...variants, poster: { objectKey: 'video/poster.jpg', mime: 'image/jpeg' } });
	f.objects.set('video/poster.jpg', Buffer.from('old-poster'));
	assert.equal((await f.preview(f.record, 'poster')).version, 2);
	assert.equal(f.objects.has('video/poster.jpg'), false);
	await f.preview(f.record, 'poster');
	assert.equal(calls, 1);
});

test('转换失败可重试，临时文件已清理', async () => {
	let inputPath;
	const f = fixture(async (input) => { inputPath = input; throw new Error('转换失败'); });
	await assert.rejects(f.preview(f.record), /转换失败/);
	await assert.rejects(fs.stat(inputPath), { code: 'ENOENT' });
	await assert.rejects(f.preview(f.record), /转换失败/);
	assert.equal(JSON.parse(f.record.variants).preview, undefined);
});

test('转换期间删除附件，不保存预览记录及对象', async () => {
	const f = fixture(async (input, output) => {
		f.record.status = 'deleting';
		await fs.writeFile(output, 'mp4');
	});
	await assert.rejects(f.preview(f.record), /附件不可用/);
	assert.equal(f.objects.size, 0);
	assert.equal(JSON.parse(f.record.variants).preview, undefined);
});
