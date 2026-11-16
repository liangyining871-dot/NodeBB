'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = filename => fs.readFileSync(path.join(__dirname, '../public/src/client', filename), 'utf8');

test('普通用户删除主题后直接返回板块，不渲染删除提示', () => {
	let tools;
	const destinations = [];
	const context = {
		define(name, dependencies, factory) { tools = factory({ get: () => ({ attr: () => '10' }) }); },
		app: { user: { isAdmin: false }, parseAndTranslate() { throw new Error('不应渲染软删除提示'); } },
		ajaxify: { data: { category: { slug: '5/test' } }, go: url => destinations.push(url) },
	};
	vm.runInNewContext(read('topic/threadTools.js'), context);
	tools.setDeleteState({ tid: 10, isDelete: true });
	assert.deepEqual(destinations, ['category/5/test']);
});

test('板块实时删除事件使用服务端 isDelete 字段移除条目', () => {
	const source = read('category/tools.js');
	const start = source.indexOf('function setDeleteState(');
	const end = source.indexOf('function setPinnedState(', start);
	let removed = false;
	const handler = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
		app: { user: { isAdmin: false } }, getTopicEl: () => ({ remove() { removed = true; } }),
	});
	handler({ tid: 10, isDelete: true });
	assert.equal(removed, true);
});

test('首页删除预览立即消失，切换页面后移除监听', async () => {
	let categories;
	let cleanup;
	let removed = '';
	const listeners = {};
	const window = {};
	vm.runInNewContext(read('categories.js'), {
		define(name, dependencies, factory) { categories = factory({ init() {} }); },
		app: { enterRoom() {} }, window,
		$(target) { return target === window ? { one(event, handler) { cleanup = handler; } } :
			{ remove() { removed = target; } }; },
		socket: { on(event, handler) { listeners[event] = handler; }, removeListener(event) { delete listeners[event]; } },
	});
	await categories.init();
	listeners['event:topic_deleted']({ tid: 10 });
	assert.match(removed, /data-tid="10"/);
	cleanup();
	assert.equal(Object.keys(listeners).length, 0);
});
