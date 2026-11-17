'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function fixture({ fail = false, onPut } = {}) {
	let direct;
	const requests = [];
	const puts = [];
	const signed = [];
	let attempts = 0;
	class XHR {
		constructor() { this.upload = {}; }
		open(method, url) { this.url = url; assert.equal(method, 'PUT'); }
		abort() { this.stopped = true; this.onabort(); }
		send(blob) {
			puts.push({ size: blob.size, url: this.url });
			queueMicrotask(() => {
				if (this.stopped) { return; }
				this.upload.onprogress({ loaded: blob.size });
				onPut?.();
				if (this.stopped) { return; }
				this.status = fail && attempts++ === 0 ? 503 : 200;
				this.onload();
			});
		}
	}
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../static/direct-upload.js'), 'utf8'), {
		define(name, deps, factory) { direct = factory(); },
		config: { relative_path: '/forum', csrf_token: 'token' },
		DOMException, AbortController, AbortSignal, XMLHttpRequest: XHR, setTimeout, clearTimeout, FormData,
		async fetch(url, options) {
			assert.equal(options.headers['x-csrf-token'], 'token');
			assert.equal(options.credentials, 'same-origin');
			requests.push(url);
			const body = JSON.parse(options.body);
			let payload;
			if (url.endsWith('/uploads')) { payload = { id: 'task', partSize: 3, partCount: 3, concurrency: 3 }; }
			if (url.endsWith('/part')) { signed.push(body.partNumber); payload = { url: `https://minio.test/part-${body.partNumber}` }; }
			if (url.endsWith('/complete')) { payload = { url: '/forum/attachments/id/original/video.mp4' }; }
			if (url.endsWith('/cancel')) { payload = { cancelled: true }; }
			return { ok: true, async json() { return payload; } };
		},
	});
	return { direct, requests, puts, signed };
}

test('浏览器只向 MinIO 发送分片，失败重取签名；论坛仅接收任务元数据', async () => {
	const f = fixture({ fail: true });
	const progress = [];
	const file = new File(['12345678'], 'video.mp4', { type: 'video/mp4' });
	const result = await f.direct.uploadFile(file, { retryDelay: 0, onProgress: bytes => progress.push(bytes) });
	assert.equal(result.url, '/forum/attachments/id/original/video.mp4');
	assert.equal(f.puts.length, 4);
	assert.deepEqual(f.puts.map(part => part.size).sort(), [2, 3, 3, 3]);
	assert.ok(f.puts.every(part => part.url.startsWith('https://minio.test/')));
	assert.equal(f.signed.filter(part => part === 1).length, 2);
	assert.equal(progress.at(-1), file.size);
	assert.ok(!f.requests.some(url => url.endsWith('/cancel')));
});

test('取消中止在途分片并通知后端清理，不执行合并', async () => {
	const controller = new AbortController();
	const f = fixture({ onPut: () => controller.abort() });
	await assert.rejects(f.direct.uploadFile(new File(['12345678'], 'video.mp4'), { signal: controller.signal }), { name: 'AbortError' });
	assert.ok(f.requests.some(url => url.endsWith('/cancel')));
	assert.ok(!f.requests.some(url => url.endsWith('/complete')));
});

test('编辑器视频突破普通附件上限，混选普通文件保持原限制并按原格式回调', async (t) => {
	const dom = new JSDOM('<div class="composer" data-uuid="post"><div class="write"></div><button data-action="post"></button></div>',
		{ url: 'http://forum.test/', runScripts: 'outside-only' });
	t.after(() => dom.window.close());
	const { window } = dom;
	const $ = require('jquery')(window);
	window.$ = $;
	window.config = { relative_path: '', maximumFileSize: 100, privateAttachmentsDirectUpload: { enabled: true, maxBytes: 2147483648, threshold: 16 * 1024 * 1024 } };
	const uploads = { inProgress: { post: [1] } };
	let defaults = 0;
	window.require = (deps, callback) => callback({ isVideo: file => file.name.endsWith('.mp4'),
		async uploadFile(file, options) { options.onProgress(file.size); return { url: '/video' }; },
		async normalFile() { defaults += 1; return { url: '/image' }; } }, uploads);
	window.eval(fs.readFileSync(path.join(__dirname, '../static/direct-upload-client.js'), 'utf8'));
	await new Promise(resolve => $(resolve));
	const transport = { post_uuid: 'post', route: '/api/post/upload', files: [{ name: 'video.mp4', size: 2147483648 }, { name: 'image.jpg', size: 50 }] };
	$(window).trigger('filter:composer.uploadTransport', [transport]);
	assert.equal(transport.maximumFileSize(transport.files[0]), 2147483648);
	assert.equal(transport.maximumFileSize(transport.files[1]), 102400);
	let response;
	await transport.submit({ data: { cid: 2 }, success(data) { response = data; }, complete() { uploads.inProgress.post.pop(); } });
	assert.equal(defaults, 1);
	assert.deepEqual(Array.from(response.response.images, file => file.url), ['/video', '/image']);
	assert.equal($('.private-direct-upload').length, 0);
});

test('真实 Composer 选文件事件接入插件，普通用户 2GiB 视频不会被旧限额拦截', async (t) => {
	const dom = new JSDOM('<div class="composer" data-uuid="post"><div class="write"><textarea></textarea>' +
		'<form id="fileForm"><input type="file" id="files"></form></div><button data-action="post"></button></div>',
	{ url: 'http://forum.test/', runScripts: 'outside-only' });
	t.after(() => dom.window.close());
	const { window } = dom;
	const $ = require('jquery')(window);
	window.$ = $;
	$.fn.getCursorPosition = () => 0;
	$.fn.ajaxSubmit = () => assert.fail('视频不应提交给旧上传接口');
	window.config = { relative_path: '', maximumFileSize: 102400, privateAttachmentsDirectUpload: {
		enabled: true, maxBytes: 2147483648, threshold: 16 * 1024 * 1024 } };
	window.app = { user: { isAdmin: false, privileges: { 'upload:post:file': true } } };
	window.ajaxify = { data: { cid: 1 } };
	const errors = [];
	let composer;
	const translator = { async translateKey(key, args) { return `uploading-${args[0]}`; } };
	window.define = (name, deps, factory) => { composer = factory({ render() {} }, { getSelectedCid: () => 1 }, translator,
		{ error: value => errors.push(value) }, { handleDragDrop() {}, handlePaste() {} }); };
	const { patchSource } = require('../../../scripts/patch-composer');
	const composerSource = fs.readFileSync(path.join(__dirname, '../../../node_modules/nodebb-plugin-composer-default/static/lib/composer/uploads.js'), 'utf8');
	window.eval(patchSource(composerSource));
	let uploaded = 0;
	window.require = (deps, callback) => callback({ isVideo: file => file.name.endsWith('.mp4'),
		async uploadFile(file, options) { uploaded += file.size; options.onProgress(file.size); return { url: '/attachments/id/original/video.mp4' }; } }, composer);
	window.eval(fs.readFileSync(path.join(__dirname, '../static/direct-upload-client.js'), 'utf8'));
	await new Promise(resolve => $(resolve));
	composer.initialize('post');
	await Promise.resolve();
	Object.defineProperty($('#files')[0], 'files', { configurable: true, value: [{ name: 'video.mp4', type: 'video/mp4', size: 2147483648 }] });
	$('#files').trigger('change');
	await new Promise(resolve => window.setTimeout(resolve, 20));
	assert.deepEqual(errors, []);
	assert.equal(uploaded, 2147483648);
	assert.match($('textarea').val(), /\[video.mp4\]\(\/attachments\/id\/original\/video.mp4\)/);
	assert.equal(composer.inProgress.post.length, 0);
	assert.equal($('[data-action="post"]').prop('disabled'), false);
	Object.defineProperty($('#files')[0], 'files', { value: [{ name: 'too-big.mp4', type: 'video/mp4', size: 2147483649 }] });
	$('#files').trigger('change');
	assert.equal(errors[0], '[[error:file-too-big, 2097152]]');
	assert.equal(uploaded, 2147483648);
});
