'use strict';

// 使用未加入全站列表的随机记录验证真实权限，不改动已有主题、用户和授权。
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomInt } = require('node:crypto');
const requireApp = require('node:module').createRequire(path.join(__dirname, '../package.json'));
requireApp('./require-main');
requireApp('./nodebb-global');
const nconf = requireApp('nconf');
nconf.env({ separator: '__' });
const prestart = requireApp('./src/prestart');
prestart.loadConfig(path.resolve(__dirname, '../config.json'));
prestart.setupWinston();
const db = requireApp('./src/database');

async function main() {
	const created = [];
	async function seed(key, value, sorted = false) {
		assert.equal(await db.exists(key), false);
		created.push(key);
		if (sorted) { await db.sortedSetAdd(key, value.map((entry, index) => index), value); } else { await db.setObject(key, value); }
	}
	try {
		await db.init();
		const meta = requireApp('./src/meta');
		await meta.configs.init();
		const user = requireApp('./src/user');
		const privileges = requireApp('./src/privileges');
		const categories = requireApp('./src/categories');
		const posts = requireApp('./src/posts');
		const topics = requireApp('./src/topics');
		const api = requireApp('./src/api');
		const [admin] = await db.getSortedSetRange('group:administrators:members', 0, 0);
		const users = await db.getSortedSetRange('users:joindate', 0, 100);
		const admins = await user.isAdministrator(users);
		const owner = users.find((uid, index) => !admins[index]);
		assert.ok(admin && owner, '需要已有管理员和普通用户进行验证');
		const cid = randomInt(800000000, 899999000);
		const live = cid + 1;
		const deleted = cid + 2;
		const mainPid = cid + 3;
		const deletedPid = cid + 4;
		const replyPid = cid + 5;
		await seed(`category:${cid}`, { cid, name: '可见性检查', slug: `${cid}/check`, disabled: 0, parentCid: 0,
			numRecentReplies: 5, topic_count: 2 });
		for (const privilege of ['read', 'topics:read', 'posts:view_deleted']) {
			await seed(`group:cid:${cid}:privileges:groups:${privilege}:members`, ['guests', 'registered-users'], true);
		}
		for (const [tid, pid, removed] of [[live, mainPid, 0], [deleted, deletedPid, 1]]) {
			await seed(`topic:${tid}`, { tid, uid: Number(owner), cid, mainPid: pid, teaserPid: pid, deleted: removed,
				postcount: 1, slug: `${tid}/check`, title: '权限检查', timestamp: Date.now() - 1000 });
			await seed(`post:${pid}`, { pid, tid, uid: Number(owner), deleted: 0, content: '测试正文', timestamp: Date.now() - 1000 });
		}
		await seed(`post:${replyPid}`, { pid: replyPid, tid: live, uid: Number(owner), deleted: 1, content: '删除的回复' });
		await seed(`cid:${cid}:tids`, [String(live), String(deleted)], true);
		await seed(`cid:${cid}:recent_tids`, [String(live), String(deleted)], true);
		for (const uid of [0, Number(owner)]) {
			assert.equal(await privileges.topics.canRead(deleted, uid), false);
			assert.equal(await privileges.posts.canRead(replyPid, uid), false);
			assert.equal(await api.posts.getRaw({ uid }, { pid: deletedPid }), null);
			assert.equal(await api.posts.getRaw({ uid }, { pid: replyPid }), null);
			const data = { cid, uid, start: 0, stop: 19, category: { topic_count: 2 } };
			assert.deepEqual((await categories.getTopicIds(data)).map(Number), [live]);
			assert.equal(await categories.getTopicCount(data), 1);
		}
		assert.equal(await privileges.topics.canRead(deleted, Number(admin)), true);
		assert.equal(await api.posts.getRaw({ uid: Number(admin) }, { pid: deletedPid }), '测试正文');
		assert.equal((await posts.getPostSummaryByPids([deletedPid], Number(owner), { stripTags: true })).length, 0);
		for (const uid of [Number(owner), Number(admin)]) {
			const cards = [{ cid, numRecentReplies: 5 }];
			await categories.getRecentTopicReplies(cards, uid, {});
			assert.deepEqual(cards[0].posts.map(post => Number(post.tid)), [live]);
		}
		await assert.rejects(topics.tools.restore(deleted, Number(owner)));
		await topics.setTopicField(deleted, 'deleted', 0);
		assert.equal(await privileges.topics.canRead(deleted, Number(owner)), true);
		console.log('真实数据库验证通过：作者/访客不可见、管理员可读、原文接口隔离、板块分页、首页预览、恢复后可见');
	} finally {
		for (const key of created.reverse()) { await db.delete(key); }
		await db.close();
	}
}

main().then(() => { console.log('本次随机测试记录已清理'); process.exit(0); }).catch((err) => {
	console.error(err.message);
	process.exit(1);
});
