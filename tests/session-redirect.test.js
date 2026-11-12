'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../plugins/nodebb-plugin-sso-uniportal/static/session.js'), 'utf8');

function fixture({ enterprise = true, editor = false } = {}) {
	const locations = [];
	const socketEvents = {};
	const domEvents = {};
	const timers = [];
	const storage = new Map();
	const post = { action: 'topics.post', cid: 2, modified: true };
	const draftLists = [];
	const container = { attr() { return 'uuid-1'; }, find(selector) { return { val() { return { textarea: '尚未提交的正文', 'input.title': '未提交标题', 'input.tags': 'test' }[selector]; } }; } };
	let elapsed = 0;
	let status = 200;
	let marker = null;
	const response = { get status() { return status; }, headers: { get() { return marker; } } };
	const root = {
		config: { relative_path: '', ...(enterprise ? { uniportalSession: { uid: 2, serverNow: 1000, expiresAt: 2000 } } : {}) },
		app: { user: { uid: enterprise ? 2 : 1 }, require: async () => ({ on() {} }) },
		performance: { now() { return elapsed; } },
		location: { replace(url) { locations.push(url); } },
		document: { querySelector() { return editor ? {} : null; }, addEventListener(event, fn) { domEvents[event] = fn; } },
		addEventListener(event, fn) { domEvents[event] = fn; },
		setTimeout(fn, delay) { timers.push({ fn, delay }); },
		socket: { on(event, fn) { socketEvents[event] = fn; } },
		fetch: async () => response,
		localStorage: { setItem(key, value) { storage.set(key, value); } },
		utils: { generateSaveId() { return 'composer:2:test'; } },
		require(modules, callback) { callback({ posts: { 'uuid-1': post } }, { addToDraftList(set, id) { draftLists.push({ set, id }); } }); },
		$(target) {
			if (target === '[component="composer"]') { return { each(fn) { fn.call({}); } }; }
			if (target === root.document) { return { on(event, fn) { domEvents[event] = fn; } }; }
			return container;
		},
	};
	vm.runInNewContext(source, root);
	return { root, locations, timers, domEvents, socketEvents, storage, draftLists, post, response, expire() { elapsed = 1000; }, respond(code, header) { status = code; marker = header; } };
}

test('enterprise deadline and socket event redirect automatically once', async () => {
	const f = fixture();
	assert.equal(f.timers[0].delay, 1000);
	f.timers[0].fn();
	await Promise.resolve();
	assert.deepEqual(f.locations, ['/auth/uniportal']);
	f.socketEvents['event:uniportal.expired']();
	await Promise.resolve();
	assert.equal(f.locations.length, 1);
});

test('matching API 401 redirects; permission errors and unrelated 401 do not', async () => {
	const f = fixture();
	f.respond(403, '/auth/uniportal');
	await f.root.fetch('/api/v3/topics');
	assert.equal(f.locations.length, 0);
	f.respond(401, null);
	await f.root.fetch('/api/v3/topics');
	assert.equal(f.locations.length, 0);
	f.respond(401, '/auth/uniportal');
	assert.equal(await f.root.fetch('/api/v3/topics'), f.response);
	assert.deepEqual(f.locations, ['/auth/uniportal']);
});

test('focus after background expiry redirects; local admins install no handlers', async () => {
	const f = fixture();
	f.expire();
	f.domEvents.focus();
	await Promise.resolve();
	assert.deepEqual(f.locations, ['/auth/uniportal']);
	const admin = fixture({ enterprise: false });
	assert.equal(admin.timers.length, 0);
	assert.equal(Object.keys(admin.socketEvents).length, 0);
});

test('unsent content is saved to native composer drafts before redirecting', async () => {
	const f = fixture({ editor: true });
	await f.socketEvents['event:uniportal.expired']();
	const draft = JSON.parse(f.storage.get('composer:2:test'));
	assert.equal(draft.text, '尚未提交的正文');
	assert.equal(draft.title, '未提交标题');
	assert.equal(draft.cid, 2);
	assert.equal(f.post.modified, false);
	assert.equal(f.draftLists.length, 2);
	assert.deepEqual(f.locations, ['/auth/uniportal']);
});
