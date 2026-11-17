'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const benchpress = require('benchpressjs');
const external = require('../plugins/nodebb-plugin-private-attachments/external-topics');
const root = path.join(__dirname, '../plugins/nodebb-plugin-private-attachments');

test('文档及封面只允许 HTTP(S)，拒绝脚本、账号密码及超长链接', () => {
	for (const externalUrl of ['javascript:alert(1)', 'data:text/html,hi', 'file:///x', '//wiki.test/a', 'https://u:p@wiki.test', 'x'.repeat(2049)]) {
		assert.throws(() => external.validate({ externalUrl }));
	}
	assert.throws(() => external.validate({ externalUrl: 'https://wiki.test', externalCover: 'javascript:alert(1)' }));
	assert.equal(external.webUrl(' https://wiki.test/文档 '), 'https://wiki.test/%E6%96%87%E6%A1%A3');
});

test('创建、编辑、恢复普通主题均随原生主题字段保存，不破坏 Hook 上下文', () => {
	const payload = { req: {}, topic: { tid: 1 }, data: { externalUrl: 'https://wiki.test/page', content: '文档介绍' } };
	assert.equal(external.save(payload), payload);
	assert.equal(payload.topic.externalUrl, 'https://wiki.test/page');
	const edited = { ...payload.topic };
	external.save({ topic: edited, data: { content: '更新后的介绍' } });
	assert.equal(edited.externalUrl, payload.topic.externalUrl);
	assert.equal(edited.externalDescription, '更新后的介绍');
	external.save({ topic: edited, data: { externalUrl: '', externalCover: 'https://image.test/x', content: '普通正文' } });
	assert.equal(edited.externalUrl, '');
	assert.equal(edited.externalCover, '');
	assert.equal(edited.externalDescription, '');
	const normal = { topic: { tid: 3 }, data: { content: '普通主题不重复保存摘要' } };
	external.save(normal);
	assert.ok(!Object.hasOwn(normal.topic, 'externalDescription'));
});

test('卡片使用主帖介绍，封面覆盖自动预览，保留原始链接供模板转义', () => {
	const topic = { externalUrl: 'https://wiki.test/?a=1&b=2', externalCover: 'https://image.test/a.png',
		externalDescription: '<img src=x onerror=alert(1)>', teaser: { content: '最后一条回复' }, mediaPreview: { url: '/old.jpg', isVideo: true } };
	external.decorate({ topics: [topic] });
	assert.equal(topic.externalLink.url, 'https://wiki.test/?a=1&b=2');
	assert.equal(topic.externalLink.description, topic.externalDescription);
	assert.ok(!topic.mediaPreview.isVideo);
	assert.ok(!external.decorate({ topics: [{ externalUrl: 'javascript:alert(1)' }] }).topics[0].externalLink);
});

test('普通卡片仍进入主题，外部卡片标题、主体和封面新窗口打开且保留讨论入口', async () => {
	benchpress.registerHelper('buildAvatar', () => '');
	benchpress.registerHelper('tx', key => key);
	benchpress.registerHelper('humanReadableNumber', value => String(value || 0));
	const topics = [
		{ tid: 1, slug: '1/normal', title: '普通主题' },
		{ tid: 2, slug: '2/wiki', title: 'Wiki', externalUrl: 'https://wiki.test/?x=1&y=2', externalCover: 'https://image.test/a.png', externalDescription: '主帖介绍<script>alert(1)</script>' },
	].map(topic => ({ user: { username: '作者' }, category: { name: '板块' }, teaser: { content: '最后回复' }, ...topic }));
	external.decorate({ topics });
	const html = await benchpress.compileRender(fs.readFileSync(path.join(root, 'templates/topic-cards.tpl'), 'utf8'), { topics, config: { relative_path: '/forum' } });
	const document = new JSDOM(html).window.document;
	const cards = document.querySelectorAll('[component="category/topic"]');
	assert.equal(cards[0].querySelector('[component="topic/header"]').getAttribute('href'), '/forum/topic/1/normal');
	assert.equal(cards[0].querySelectorAll('[target="_blank"]').length, 0);
	for (const link of cards[1].querySelectorAll('[target="_blank"]')) {
		assert.equal(link.getAttribute('href'), 'https://wiki.test/?x=1&y=2');
		assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
	}
	assert.equal(cards[1].querySelectorAll('[target="_blank"]').length, 3);
	assert.equal(cards[1].querySelectorAll('.topic-card-external-badge').length, 1);
	assert.ok(cards[1].querySelector('.topic-card-external-badge').textContent.includes('外部链接'));
	assert.equal(cards[1].querySelector('.topic-card-excerpt').textContent, '主帖介绍<script>alert(1)</script>');
	assert.equal(cards[1].querySelectorAll('script').length, 0);
	assert.equal(cards[1].querySelector('.topic-card-stats a').getAttribute('href'), '/forum/topic/2/wiki');
});

function composer() {
	const dom = new JSDOM('<div id="composer"><div class="title-container"><input class="title"></div><textarea>简短介绍</textarea></div>');
	const $ = require('jquery')(dom.window);
	const handlers = {};
	vm.runInNewContext(fs.readFileSync(path.join(root, 'static/external-topics.js'), 'utf8'), {
		$: value => (typeof value === 'function' ? value() : $(value)), URL,
		require(deps, callback) {
			callback({ on(name, method) {
				// 与原生 Hook 一样执行所有监听器，不能覆盖同名监听器而漏掉重复注册错误。
				const previous = handlers[name];
				handlers[name] = (data) => { if (previous) { previous(data); } return method(data); };
			} });
		},
	});
	return { $, handlers, container: $('#composer') };
}

test('编辑器勾选外部文档后提交链接及封面，非法链接被前端拦截', () => {
	const { handlers, container } = composer();
	const postData = { action: 'topics.post' };
	handlers['action:composer.enhanced']({ postContainer: container, postData });
	container.find('input[type="checkbox"]').prop('checked', true).trigger('change');
	container.find('input[type="url"]').eq(0).val('https://wiki.test/a').trigger('input');
	container.find('input[type="url"]').eq(1).val('https://image.test/a.png').trigger('input');
	const submit = { composerEl: container, composerData: {} };
	handlers['filter:composer.submit'](submit);
	assert.equal(submit.composerData.externalUrl, 'https://wiki.test/a');
	assert.equal(submit.composerData.externalCover, 'https://image.test/a.png');
	const check = { postContainer: container };
	handlers['filter:composer.check'](check);
	assert.ok(!check.error);
	container.find('input[type="url"]').eq(0).val('javascript:alert(1)');
	handlers['filter:composer.check'](check);
	assert.ok(check.error);
});

test('草稿保存并恢复链接，完整编辑页回填字段，取消勾选恢复普通主题', () => {
	const { handlers, container } = composer();
	const draft = { externalUrl: 'https://wiki.test/draft', externalCover: 'https://image.test/draft.png' };
	handlers['action:composer.enhanced']({ postContainer: container, postData: {}, draft });
	const saved = { postContainer: container, draft: {} };
	handlers['filter:composer.drafts.save'](saved);
	assert.equal(saved.draft.externalUrl, draft.externalUrl);
	container.find('input[type="checkbox"]').prop('checked', false).trigger('change');
	const submit = { composerEl: container, composerData: {} };
	handlers['filter:composer.submit'](submit);
	assert.equal(submit.composerData.externalUrl, '');
	const fullPage = composer();
	fullPage.handlers['action:composer.enhanced']({ postContainer: fullPage.container, postData: { topic: draft } });
	assert.equal(fullPage.container.find('input[type="url"]').first().val(), draft.externalUrl);
});

test('回复不显示扩展字段，也不向请求附加主题链接', () => {
	const { handlers, container } = composer();
	container.find('input.title').remove();
	handlers['action:composer.enhanced']({ postContainer: container, postData: { action: 'posts.reply' } });
	assert.equal(container.find('.external-topic-fields').length, 0);
	const submit = { composerEl: container, composerData: {} };
	handlers['filter:composer.submit'](submit);
	assert.ok(!Object.hasOwn(submit.composerData, 'externalUrl'));
});
