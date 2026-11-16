'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const benchpress = require('benchpressjs');

test('顶部板块按权限、数据库顺序及名称动态生成，支持子路径', async () => {
	const boards = [{ cid: 3, name: '交流中心' }, { cid: 1, name: '工单中心' }, { cid: 2, name: '隐藏板块' }];
	const dependencies = {
		'../categories': { async getAllCidsFromSet() { return boards.map(board => board.cid); },
			async getCategoriesFields(ids) { return ids.map(id => boards.find(board => board.cid === id)); } },
		'../privileges': { categories: { async filterCids(privilege, ids, uid) { return ids.filter(id => uid === 1 || id !== 2); } } },
		nconf: { get() { return '/forum'; } },
	};
	const context = { module: { exports: {} }, require: name => dependencies[name] };
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/navigation/boards.js'), 'utf8'), context);
	const navigation = await context.module.exports(2);
	assert.deepEqual(Array.from(navigation, item => item.text), ['全部', '交流中心', '工单中心']);
	assert.equal(navigation[1].route, '/forum/recent?cid=3');
	assert.equal((await context.module.exports(1)).length, 4);
	boards[0].name = '新板块名';
	assert.equal((await context.module.exports(2))[1].text, '新板块名');
});

test('文字、图片、视频主题统一标题与底栏，仅媒体主题采用摘要加预览布局', async () => {
	const source = fs.readFileSync(path.join(__dirname,
		'../plugins/nodebb-plugin-private-attachments/templates/topic-cards.tpl'), 'utf8');
	benchpress.registerHelper('buildAvatar', () => '<span class="avatar"></span>');
	benchpress.registerHelper('tx', key => key);
	benchpress.registerHelper('humanReadableNumber', value => String(value || 0));
	const topics = [
		{ tid: 1, title: '文字主题', slug: '1/text', teaser: { content: '很长的正文'.repeat(100) } },
		{ tid: 2, title: '图片主题', slug: '2/image', mediaPreview: { url: '/image.jpg' } },
		{ tid: 3, title: '视频主题', slug: '3/video', mediaPreview: { url: '/poster.jpg', videoUrl: '/movie.mp4', isVideo: true } },
	].map(topic => ({ user: { username: '作者' }, category: { name: '板块' }, ...topic }));
	const html = await benchpress.compileRender(source, { topics, config: { relative_path: '' } });
	assert.equal((html.match(/component="category\/topic"/g) || []).length, 3);
	assert.equal((html.match(/class="topic-card-content"/g) || []).length, 3);
	assert.equal((html.match(/class="topic-card-excerpt"/g) || []).length, 3);
	assert.equal((html.match(/component="topic\/header"/g) || []).length, 3);
	assert.equal((html.match(/topic-card-body-media/g) || []).length, 2);
	assert.ok(!html.includes('topic-card-placeholder'));
	assert.ok(html.includes('src="/image.jpg"'));
	assert.ok(html.includes('data-video-src="/movie.mp4"'));
	assert.ok(html.includes('category-media-play'));
});

test('主帖已在摘要中取过封面时直接复用，仅补查其他主帖', async () => {
	const source = fs.readFileSync(path.join(__dirname, '../plugins/nodebb-plugin-private-attachments/library.js'), 'utf8');
	const start = source.indexOf('exports.previewTopics =');
	const end = source.indexOf('exports.deleteUserResources', start);
	const lookedUp = [];
	const context = { exports: {}, async previewSummaries(data) {
		for (const teaser of data.teasers) { lookedUp.push(teaser.pid); teaser.mediaPreview = { url: `main-${teaser.pid}` }; }
	} };
	vm.runInNewContext(source.slice(start, end), context);
	const data = { uid: 2, topics: [
		{ mainPid: 10, teaser: { pid: 10, mediaPreview: { url: 'cached-cover' } } },
		{ mainPid: 20, teaser: { pid: 21, mediaPreview: { url: 'reply-cover' } } },
	] };
	await context.exports.previewTopics(data);
	assert.deepEqual(lookedUp, [20]);
	assert.equal(data.topics[0].mediaPreview.url, 'cached-cover');
	assert.equal(data.topics[1].mediaPreview.url, 'main-20');
});

test('全部主题不受最近数量上限截断，按权限过滤并正常分页', async () => {
	const records = { 4: { tid: 4, cid: 1, deleted: 1, tags: [] }, 3: { tid: 3, cid: 9, tags: [] },
		2: { tid: 2, cid: 1, tags: [] }, 1: { tid: 1, cid: 2, tags: [] } };
	const calls = [];
	const dependencies = {
		lodash: require('lodash'), '../database': { async getSortedSetRevRange(set, start, stop) {
			calls.push(stop); return ['4', '3', '2', '1'].slice(start, stop === -1 ? undefined : stop + 1);
		} },
		'../privileges': { topics: { async filterTids(privilege, ids) { return ids.filter(id => records[id].cid !== 9); } },
			categories: { async filterCids(privilege, ids) { return ids; } } },
		'../user': { blocks: { async filter(uid, data) { return data; } } },
		'../categories': {}, '../meta': { config: { recentMaxTopics: 1 } },
		'../plugins': { hooks: { hasListeners: () => false, async fire(hook, data) { return data; } } },
	};
	const context = { module: { exports: {} }, require: name => dependencies[name] };
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/topics/sorted.js'), 'utf8'), context);
	const topics = { async getTopicsFields(ids) { return ids.map(id => records[id]); },
		async getTopicsByTids(ids) { return ids.map(id => records[id]); } };
	context.module.exports(topics);
	const result = await topics.getSortedTopics({ uid: 2, start: 0, stop: 0, allVisible: true });
	assert.equal(calls[0], -1);
	assert.equal(result.topicCount, 2);
	assert.deepEqual(Array.from(result.topics, topic => topic.tid), [2]);
	const page = await topics.getSortedTopics({ uid: 2, start: 1, stop: 1, allVisible: true });
	assert.deepEqual(Array.from(page.topics, topic => topic.tid), [1]);
});
