'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('帖子文档自动展开阅读，卡片可打开弹窗，重复加载不嵌套阅读器', async (t) => {
	const source = '/forum/attachments/id/original/slides.pptx';
	const dom = new JSDOM(`<div component="post/content"><a href="${source}">slides</a>` +
		'<a href="/forum/attachments/id/original/report.pdf">report</a>' +
		['doc', 'docx', 'xls', 'xlsx'].map(ext => `<a href="/forum/attachments/id/original/sample.${ext}">sample.${ext}</a>`).join('') +
		'<a href="https://other.test/slides.pptx">external</a></div>' +
		`<a class="category-media-preview" data-document-src="${source}?preview=1"><img alt="slides"></a>`,
	{ url: 'https://forum.test/forum/', runScripts: 'outside-only' });
	t.after(() => dom.window.close());
	const { window } = dom;
	window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
	window.HTMLDialogElement.prototype.close = function () { this.dispatchEvent(new window.Event('close')); };
	const $ = require('jquery')(window);
	window.$ = $;
	window.config = { relative_path: '/forum' };
	window.eval(await fs.readFile(path.join(__dirname, '../static/documents.js'), 'utf8'));
	await new Promise(resolve => $(resolve));
	$(window).trigger('action:posts.loaded');
	assert.equal($('.private-document-card').length, 6);
	assert.equal($('.private-document-inline').length, 6);
	assert.equal($('.private-document-card button').length, 0);
	assert.equal($('.private-document-card img').length, 0);
	assert.equal($('dialog').length, 0);
	assert.equal($('[href="https://other.test/slides.pptx"]').length, 1);
	assert.equal($('.private-document-card a[href$="?download=1"]').length, 6);
	assert.equal($('.private-document-card a[target="_blank"]').length, 6);
	assert.equal($('.private-document-inline').first().attr('src'), `https://forum.test${source}?preview=1#view=FitH`);
	assert.equal($('.private-document-inline').eq(1).attr('src'), 'https://forum.test/forum/attachments/id/original/report.pdf?preview=1#view=FitH');
	assert.equal($('.private-document-inline').first().attr('loading'), 'eager');
	$(window).trigger('action:posts.edited');
	assert.equal($('.private-document-card').length, 6);
	assert.equal($('.private-document-inline').length, 6);
	$('.category-media-preview').trigger('click');
	assert.equal($('dialog').length, 1);
	assert.equal($('dialog iframe').attr('src'), `https://forum.test${source}?preview=1`);
	$('dialog button').trigger('click');
	assert.equal($('dialog').length, 0);
	$('.category-media-preview').trigger('click');
	$(window).trigger('action:ajaxify.start');
	assert.equal($('dialog').length, 0);
	assert.equal($('.private-document-inline').length, 0);
});
