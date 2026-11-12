'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
process.chdir(root);
const nconf = require('nconf');
nconf.env({ separator: '__' }).file({ file: path.join(root, 'config.json') });
const db = require(path.join(root, 'src/database'));

(async () => {
	try {
		const report = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
		if (!report.runId || !report.created || !(report.cid > 0)) { throw new Error('Not a mixed-load report'); }
		await db.init();
		let topics = 0;
		let replies = 0;
		let votes = 0;
		for (const item of report.created.topics) {
			const topic = await db.getObjectFields(`topic:${item.tid}`, ['cid', 'uid', 'mainPid', 'title']);
			const post = await db.getObjectFields(`post:${item.pid}`, ['uid', 'tid', 'content']);
			if (Number(topic.cid) !== report.cid || Number(topic.uid) !== item.uid || Number(topic.mainPid) !== item.pid ||
				!topic.title?.includes(report.runId) || Number(post.uid) !== item.uid || Number(post.tid) !== item.tid || !post.content?.includes(report.runId)) { throw new Error('Topic mismatch'); }
			topics += 1;
		}
		for (const item of report.created.replies) {
			const post = await db.getObjectFields(`post:${item.pid}`, ['uid', 'tid', 'content']);
			if (Number(post.uid) !== item.uid || Number(post.tid) !== item.tid || !post.content?.includes(report.runId)) { throw new Error('Reply mismatch'); }
			replies += 1;
		}
		for (const item of report.created.votes) {
			if (!await db.isSetMember(`pid:${item.pid}:upvote`, item.uid)) { throw new Error('Vote mismatch'); }
			votes += 1;
		}
		console.log('Verified persisted mixed-load writes:', JSON.stringify({ cid: report.cid, topics, replies, votes }));
		console.log('Audit:', JSON.stringify({ globalPostQueue: await db.getObjectField('config', 'postQueue'), testCategoryPostQueue: await db.getObjectField(`category:${report.cid}`, 'postQueue') }));
	} finally { if (db.pool) { await db.pool.end(); } }
})().then(() => process.exit(0)).catch(() => { console.error('Mixed-load database verification failed; no credentials printed.'); process.exit(1); });
