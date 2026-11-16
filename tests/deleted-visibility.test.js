'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(filename, dependencies) {
	const context = { module: { exports: {} }, require(name) {
		if (!(name in dependencies)) { throw new Error(`Unexpected dependency: ${name}`); }
		return dependencies[name];
	} };
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src', filename), 'utf8'), context);
	return context.module.exports;
}

function fixture() {
	const records = { 10: { tid: 10, cid: 5, uid: 2, deleted: 1 }, 11: { tid: 11, cid: 5, uid: 2, deleted: 0 } };
	const postRecords = { 20: { pid: 20, tid: 10, uid: 2, deleted: 0 },
		21: { pid: 21, tid: 11, uid: 2, deleted: 1 }, 22: { pid: 22, tid: 11, uid: 2, deleted: 0 } };
	const user = { async isAdministrator(uid) { return uid === 1; }, async isModerator(uid, cids) {
		return Array.isArray(cids) ? cids.map(() => uid === 3) : uid === 3;
	} };
	const helpers = { async isAllowedTo(privileges, uid, cid) {
		// 模拟旧版块把“查看删除内容”授予所有人，验证此授权也不能绕过管理员限制。
		return (Array.isArray(privileges) ? privileges : cid).map(() => true);
	} };
	const topics = { async getTopicFields(id) { return records[id] || {}; },
		async getTopicData(id) { return records[id]; }, async getTopicField(id, field) { return records[id]?.[field]; },
		async getTopicsFields(ids) { return ids.map(id => records[id] || {}); } };
	const posts = { async getPostsFields(ids) { return ids.map(id => postRecords[id] || {}); },
		async getPostFields(id) { return postRecords[id] || {}; }, async getCidByPid() { return 5; } };
	const categories = { async getCategoryField() { return false; },
		async getCategoriesFields(ids) { return ids.map(() => ({ disabled: false })); } };
	const utils = { isNumber: value => /^\d+$/.test(String(value)),
		async promiseParallel(values) { return Object.fromEntries(await Promise.all(Object.entries(values).map(async ([key, value]) => [key, await value]))); } };
	const dependencies = { lodash: require('lodash'), '../database': {}, '../meta': { config: {} }, '../user': user,
		'../topics': topics, '../posts': posts, '../categories': categories, './helpers': helpers,
		'../plugins': { hooks: { async fire(hook, data) { return data; } } }, '../utils': utils,
		'../groups': {}, '../activitypub': {}, '../promisify': () => {} };
	const categoryPrivileges = load('privileges/categories.js', dependencies);
	dependencies['./categories'] = categoryPrivileges;
	const topicPrivileges = load('privileges/topics.js', dependencies);
	dependencies['./topics'] = topicPrivileges;
	const postPrivileges = load('privileges/posts.js', dependencies);
	return { user, topics, records, categoryPrivileges, topicPrivileges, postPrivileges };
}

test('作者、普通用户、访客及版主均不能读取删除主题，管理员可以', async () => {
	const f = fixture();
	for (const uid of [0, 2, 3, 4]) {
		assert.equal((await f.topicPrivileges.get(10, uid)).view_deleted, false);
		assert.equal(await f.topicPrivileges.canRead(10, uid), false);
		assert.deepEqual(Array.from(await f.topicPrivileges.filterTids('topics:read', [10, 11], uid)), [11]);
		assert.equal((await f.categoryPrivileges.get(5, uid)).view_deleted, false);
	}
	assert.equal(await f.topicPrivileges.canRead(10, 1), true);
	assert.deepEqual(Array.from(await f.topicPrivileges.filterTids('topics:read', [10, 11], 1)), [10, 11]);
});

test('删除回复、原文和列表过滤没有作者及版主例外，正常内容不受影响', async () => {
	const f = fixture();
	for (const uid of [0, 2, 3, 4]) {
		assert.equal((await f.postPrivileges.get([21], uid))[0]['topics:read'], false);
		assert.equal((await f.postPrivileges.get([21], uid))[0]['posts:view_deleted'], false);
		assert.equal(await f.postPrivileges.canRead(21, uid), false);
		assert.equal(await f.postPrivileges.can('topics:read', 20, uid), false);
		assert.deepEqual(Array.from(await f.postPrivileges.filter('topics:read', [20, 21, 22], uid)), [22]);
		assert.equal(await f.postPrivileges.canRead(22, uid), true);
	}
	assert.equal(await f.postPrivileges.canRead(21, 1), true);
});

test('板块列表在分页之前移除删除主题，置顶排序和总数保持一致', async () => {
	const f = fixture();
	const ids = ['10', '11', '12', '13'];
	f.records[12] = { tid: 12, cid: 5, deleted: 1 };
	f.records[13] = { tid: 13, cid: 5, deleted: 0 };
	const categories = { async getPinnedTids() { return ['12', '11']; }, async buildTopicsSortedSet() { return 'set'; } };
	const initialize = load('categories/topics.js', { '../database': { async getSortedSetRevRange() { return ids; } },
		'../topics': {}, '../plugins': { hooks: { hasListeners: () => false } }, '../meta': {},
		'../privileges': { topics: f.topicPrivileges },
		'../user': f.user, '../utils': {} });
	initialize(categories);
	categories.getPinnedTids = async () => ['12', '11'];
	categories.buildTopicsSortedSet = async () => 'set';
	const data = { cid: 5, uid: 2, start: 0, stop: 0 };
	assert.deepEqual(Array.from(await categories.getTopicIds(data)), ['11']);
	assert.equal(await categories.getTopicCount(data), 2);
	assert.deepEqual(Array.from(await categories.getTopicIds({ ...data, start: 1, stop: 1 })), ['13']);
	const display = [{ tid: 10, deleted: 1, isOwner: true }, { tid: 11, deleted: 0 }];
	await categories.modifyTopicsByPrivilege(display, { view_deleted: false });
	assert.deepEqual(display.map(topic => topic.tid), [11]);
	const adminData = { ...data, uid: 1, stop: 19, category: { topic_count: 4 } };
	assert.deepEqual(Array.from(await categories.getTopicIds(adminData)), ['12', '11', '10', '13']);
	assert.equal(await categories.getTopicCount(adminData), 4);
});

test('普通用户不能通过恢复接口找回软删除回复，管理员可以恢复', async () => {
	const posts = { async getPostData() { return { deleted: 1 }; },
		async restore() { return { deleted: 0 }; }, async parsePost(post) { return post; } };
	load('posts/tools.js', { '../privileges': { posts: { async canDelete() { return { flag: true }; } } },
		'../user': { async isAdministrator(uid) { return uid === 1; } } })(posts);
	await assert.rejects(posts.tools.restore(2, 20), /no-privileges/);
	assert.equal((await posts.tools.restore(1, 20)).deleted, 0);
});
