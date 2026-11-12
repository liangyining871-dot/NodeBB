'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
process.chdir(root);
require(path.join(root, 'require-main'));
require(path.join(root, 'nodebb-global'));
const winston = require('winston');
winston.configure({ silent: true, transports: [new winston.transports.Console()] });
const nconf = require('nconf');
nconf.env({ separator: '__' });
require(path.join(root, 'src/prestart')).loadConfig(path.join(root, 'config.json'));
const db = require(path.join(root, 'src/database'));

(async () => {
	try {
		await db.init();
		const meta = require(path.join(root, 'src/meta'));
		await meta.configs.init();
		meta.config.activitypubEnabled = 0;
		const groups = require(path.join(root, 'src/groups'));
		const categories = require(path.join(root, 'src/categories'));
		const privileges = require(path.join(root, 'src/privileges'));
		const accounts = JSON.parse(await fs.readFile(path.join(__dirname, 'accounts.json'), 'utf8'));
		const name = 'load-test-users';
		if (!await groups.exists(name)) { await groups.create({ name, hidden: 1, private: 1, disableJoinRequests: 1 }); }
		for (const account of accounts) {
			if (!account.uid || Number(await db.getObjectField(`user:${account.uid}`, 'loadTestAccount')) !== 1) { throw new Error('Unexpected account'); }
			await groups.join(name, account.uid);
		}
		let cid = Number(await db.getObjectField('loadtest:settings', 'cid'));
		if (!cid) {
			const category = await categories.create({ name: 'Load Test - 压测专用', description: '自动压测产生的数据，仅测试账号与管理员可见。', order: 999 });
			cid = Number(category.cid);
			await db.setObjectField('loadtest:settings', 'cid', cid);
			await categories.setCategoryField(cid, 'loadTestCategory', 1);
		}
		if (Number(await db.getObjectField(`category:${cid}`, 'loadTestCategory')) !== 1) { throw new Error('Unexpected category'); }
		await privileges.categories.rescind(privileges.categories.getGroupPrivilegeList(), cid, ['registered-users', 'fediverse', 'guests', 'spiders']);
		await privileges.categories.give(['groups:find', 'groups:read', 'groups:topics:read', 'groups:topics:create', 'groups:topics:reply', 'groups:posts:upvote'], cid, [name]);
		// Scope the direct-publication test to this category; production categories remain unchanged.
		await categories.setCategoryField(cid, 'postQueue', 0);
		const config = {
			baseUrl: new URL(nconf.get('url')).origin, users: 25, durationSeconds: 75, thinkTimeMs: 1000,
			accountsFile: 'accounts.json', cid, maxTopics: 5, maxReplies: 15, maxVotes: 25,
		};
		await fs.writeFile(path.join(__dirname, 'mixed.local.json'), JSON.stringify(config, null, 2));
		console.log(`Prepared private test category cid=${cid}; only test accounts and administrators can read it. Queue disabled only in this category.`);
		console.log('Posting restrictions:', JSON.stringify({ postDelay: meta.config.postDelay, newbiePostDelay: meta.config.newbiePostDelay, initialPostDelay: meta.config.initialPostDelay }));
	} finally { if (db.pool) { await db.pool.end(); } }
})().then(() => process.exit(0)).catch(() => { console.error('Mixed-load preparation failed; no credentials printed.'); process.exit(1); });
