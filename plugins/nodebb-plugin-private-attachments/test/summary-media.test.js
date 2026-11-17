'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSummaryMedia } = require('../summary-media');

const id = '12345678-1234-1234-1234-123456789abc';
const source = `/forum/attachments/${id}/original/test.mp4`;

function fixture({ mime = 'video/mp4', name = 'test.mp4', content = `[视频](${source})`, readable = true, variants = {} } = {}) {
	const record = { id, mime, name, variants: JSON.stringify(variants) };
	let checkedUid;
	const preview = createSummaryMedia({
		baseUrl: 'https://forum.test/forum', relativePath: '/forum',
		posts: { async getPostsFields() { return [{ pid: 7, content }]; } },
		db: { async getObject() { return record; } },
		async canRead(value, uid) { checkedUid = uid; return readable; },
	});
	return { preview, get checkedUid() { return checkedUid; } };
}

test('摘要附加视频封面，保留纯文字，兼容空摘要', async () => {
	const f = fixture();
	const data = { teasers: [null, { pid: 7, content: '原摘要' }], uid: 12 };
	await f.preview(data);
	assert.equal(data.teasers[1].content, '原摘要');
	assert.equal(data.teasers[1].mediaPreview.url, `${source}?poster=1`);
	assert.equal(data.teasers[1].mediaPreview.isVideo, true);
	assert.equal(f.checkedUid, 12);
});

test('图片优先使用缩略图，无权限时不暴露预览', async () => {
	const f = fixture({ mime: 'image/jpeg', name: '图片.jpg', variants: { thumbnail: {} } });
	const data = { teasers: [{ pid: 7 }], uid: 12 };
	await f.preview(data);
	assert.match(data.teasers[0].mediaPreview.url, /\/thumbnail\//);
	assert.equal(data.teasers[0].mediaPreview.isVideo, false);
	await fixture({ readable: false }).preview(data);
	assert.equal(data.teasers[0].mediaPreview, undefined);
});

test('PDF、演示文稿、Word、Excel 生成首页封面与阅读地址，无权限时不暴露', async () => {
	for (const name of ['test.pdf', 'test.ppt', 'test.pptx', 'test.doc', 'test.docx', 'test.xls', 'test.xlsx']) {
		const data = { teasers: [{ pid: 7 }], uid: 12 };
		await fixture({ name, mime: 'application/pdf' }).preview(data);
		assert.equal(data.teasers[0].mediaPreview.isDocument, true);
		assert.match(data.teasers[0].mediaPreview.url, /\?poster=1$/);
		assert.match(data.teasers[0].mediaPreview.documentUrl, /\?preview=1$/);
		await fixture({ name, mime: 'application/pdf', readable: false }).preview(data);
		assert.equal(data.teasers[0].mediaPreview, undefined);
	}
});

test('外站附件和普通文件不生成预览', async () => {
	for (const options of [
		{ content: `[视频](https://other.test${source})` },
		{ mime: 'text/plain', name: 'test.txt' },
		{ content: '无附件的文字' },
	]) {
		const data = { teasers: [{ pid: 7 }], uid: 12 };
		await fixture(options).preview(data);
		assert.equal(data.teasers[0].mediaPreview, undefined);
	}
});
