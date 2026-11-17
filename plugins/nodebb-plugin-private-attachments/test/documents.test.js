'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { Readable } = require('node:stream');
const { createDocumentPreview } = require('../documents');

function fixture({ name = 'slides.pptx', convert, poster } = {}) {
	const record = { id: 'document', name, status: 'attached', variants: JSON.stringify({ original: { objectKey: 'original', mime: 'application/pdf' } }) };
	const objects = new Map([['original', Buffer.from('original')]]);
	const db = {
		async getObject() { return record; },
		async setObjectField(key, field, value) { record[field] = value; },
	};
	const client = {
		async getObject(bucket, key) { return Readable.from(objects.get(key)); },
		async fPutObject(bucket, key, source) { objects.set(key, await fs.readFile(source)); },
		async removeObject(bucket, key) { objects.delete(key); },
	};
	return { record, objects, preview: createDocumentPreview({ db, getStorage: () => ({ client, bucket: 'private' }), convert, poster }) };
}

test('并发封面和预览共用一次 PPT 转换，保留原件且复用缓存', async () => {
	let conversions = 0;
	let posters = 0;
	const f = fixture({ convert: async (input, output) => {
		conversions += 1;
		await fs.writeFile(output, 'pdf');
	}, poster: async (input, output) => {
		posters += 1;
		assert.equal(await fs.readFile(input, 'utf8'), 'pdf');
		await fs.writeFile(output, 'png');
	} });
	const [cover, pdf] = await Promise.all([f.preview(f.record, 'documentPoster'), f.preview(f.record), f.preview(f.record)]);
	assert.equal(cover.mime, 'image/png');
	assert.equal(pdf.mime, 'application/pdf');
	await f.preview(f.record, 'documentPoster');
	assert.equal(conversions, 1);
	assert.equal(posters, 1);
	assert.equal(f.objects.get('original').toString(), 'original');
});

test('PDF 原件直接阅读，封面无需 Office 转换', async () => {
	const f = fixture({ name: 'test.pdf', convert: () => assert.fail('PDF must not be converted'),
		poster: async (input, output) => fs.writeFile(output, 'png') });
	assert.equal((await f.preview(f.record)).objectKey, 'original');
	assert.equal((await f.preview(f.record, 'documentPoster')).mime, 'image/png');
});

test('Word、Excel 新旧格式共用转换缓存，原件扩展名保留供正确识别', async () => {
	for (const extension of ['doc', 'docx', 'xls', 'xlsx']) {
		let calls = 0;
		const f = fixture({ name: `sample.${extension}`, convert: async (input, output) => {
			assert.ok(input.endsWith(`.${extension}`));
			calls += 1;
			await fs.writeFile(output, 'pdf');
		}, poster: async (input, output) => fs.writeFile(output, 'png') });
		assert.equal((await f.preview(f.record, 'documentPoster')).mime, 'image/png');
		assert.equal((await f.preview(f.record)).mime, 'application/pdf');
		assert.equal(calls, 1);
		assert.equal(f.objects.get('original').toString(), 'original');
	}
});

test('转换失败可重试且清理临时文件，转换期间删除不发布预览', async () => {
	let inputPath;
	const f = fixture({ convert: async input => { inputPath = input; throw new Error('failed'); } });
	await assert.rejects(f.preview(f.record), /failed/);
	await assert.rejects(fs.stat(inputPath), { code: 'ENOENT' });
	await assert.rejects(f.preview(f.record), /failed/);
	const deleted = fixture({ convert: async (input, output) => {
		deleted.record.status = 'deleting';
		await fs.writeFile(output, 'pdf');
	} });
	await assert.rejects(deleted.preview(deleted.record), /附件不可用/);
	assert.equal(deleted.objects.size, 1);
});
