'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { decorateCardVotes } = require('../card-votes');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, { uid = 12, upvoted = false, downvoted = false, count = 0, vote } = {}) {
	const dom = new JSDOM(`<button class="topic-card-vote" data-vote-pid="42" data-upvoted="${upvoted}" data-downvoted="${downvoted}">` +
		`<span class="topic-card-vote-count" data-votes="${count}">${count}</span></button>`,
	{ url: 'http://forum.test/', runScripts: 'outside-only' });
	t.after(() => dom.window.close());
	const { window } = dom;
	const $ = require('jquery')(window);
	const calls = [];
	const errors = [];
	const routes = [];
	window.$ = $;
	window.app = { user: { uid } };
	window.ajaxify = { go: route => routes.push(route) };
	const api = Object.fromEntries(['put', 'del'].map(method => [method, async (route, data) => {
		calls.push({ method, route, data });
		if (vote) { await vote(); }
	}]));
	window.require = (deps, callback) => callback(api, { error: message => errors.push(message) });
	window.eval(await fs.readFile(path.join(__dirname, '../static/card-votes.js'), 'utf8'));
	await new Promise(resolve => $(resolve));
	return { $, calls, errors, routes };
}

test('点赞和取消使用原生投票接口，更新计数及按钮状态', async (t) => {
	const f = await fixture(t);
	f.$('button').trigger('click'); await tick();
	assert.equal(f.calls[0].route, '/posts/42/vote');
	assert.equal(f.calls[0].method, 'put');
	assert.equal(f.calls[0].data.delta, 1);
	assert.equal(f.$('.topic-card-vote-count').text(), '1');
	assert.equal(f.$('button').attr('aria-pressed'), 'true');
	f.$('button').trigger('click'); await tick();
	assert.equal(f.calls[1].method, 'del');
	assert.equal(f.$('.topic-card-vote-count').text(), '0');
	assert.equal(f.$('button').attr('aria-pressed'), 'false');
});

test('后端拒绝（包括自己点赞）时显示错误，不改变计数，恢复按钮', async (t) => {
	const f = await fixture(t, { vote: async () => { throw new Error('[[error:self-vote]]'); } });
	f.$('button').trigger('click'); await tick();
	assert.deepEqual(f.errors, ['[[error:self-vote]]']);
	assert.equal(f.$('.topic-card-vote-count').text(), '0');
	assert.equal(f.$('button').attr('data-upvoted'), 'false');
	assert.equal(f.$('button').prop('disabled'), false);
});

test('游客转到登录页，不发投票请求', async (t) => {
	const f = await fixture(t, { uid: 0 });
	f.$('button').trigger('click'); await tick();
	assert.deepEqual(f.routes, ['login']);
	assert.equal(f.calls.length, 0);
});

test('防止重复点击，原踩票转点赞时净票数加二', async (t) => {
	let release;
	const f = await fixture(t, { downvoted: true, count: -1, vote: () => new Promise(resolve => { release = resolve; }) });
	f.$('button').trigger('click'); f.$('button').trigger('click');
	assert.equal(f.calls.length, 1);
	release(); await tick();
	assert.equal(f.$('.topic-card-vote-count').text(), '1');
	assert.equal(f.$('button').attr('data-downvoted'), 'false');
});

test('列表批量加载当前用户对主帖的投票状态，刷新后保留状态', async () => {
	const data = { uid: 12, topics: [{ mainPid: 42 }, { mainPid: 43 }, { mainPid: 0 }] };
	await decorateCardVotes(data, { async getVoteStatusByPostIDs(pids, uid) {
		assert.deepEqual(pids, [42, 43]);
		assert.equal(uid, 12);
		return { upvotes: [true, false], downvotes: [false, true] };
	} });
	assert.equal(data.topics[0].cardVote.upvoted, true);
	assert.equal(data.topics[1].cardVote.downvoted, true);
	assert.equal(data.topics[2].cardVote, undefined);
});
