'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('封面失败后加载画面、定位短视频、截图并释放视频连接', async (t) => {
	const dom = new JSDOM('<a class="category-media-preview" data-video-src="/attachments/id/original/test.mp4">' +
		'<img src="/attachments/id/original/test.mp4?poster=1"><span class="category-media-play">▶</span></a>',
	{ url: 'https://forum.test/', runScripts: 'outside-only' });
	t.after(() => dom.window.close());
	const { window } = dom;
	const $ = require('jquery')(window);
	window.$ = $;
	window.config = { relative_path: '' };
	let loads = 0;
	window.HTMLMediaElement.prototype.load = function () { loads += 1; };
	window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
	window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,frame';
	window.eval(await fs.readFile(path.join(__dirname, '../static/video.js'), 'utf8'));
	await new Promise(resolve => $(resolve));
	$('.category-media-preview img').trigger('error');
	const frame = $('video')[0];
	assert.ok(frame);
	assert.equal(frame.preload, 'auto');
	Object.defineProperty(frame, 'duration', { value: 0.5 });
	frame.dispatchEvent(new window.Event('loadedmetadata'));
	assert.equal(frame.currentTime, 0.05);
	Object.defineProperty(frame, 'videoWidth', { value: 1920 });
	Object.defineProperty(frame, 'videoHeight', { value: 1080 });
	frame.dispatchEvent(new window.Event('seeked'));
	assert.equal($('video').length, 0);
	assert.match($('img').attr('src'), /^data:image\/jpeg/);
	assert.equal($('.category-media-play').length, 1);
	assert.equal(frame.hasAttribute('src'), false);
	assert.equal(loads, 2);
});
