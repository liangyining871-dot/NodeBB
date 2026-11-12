'use strict';

// Run from the NodeBB root: node --env-file=.env plugins/nodebb-plugin-sso-uniportal/migrate-usernames.js
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
process.chdir(root);
require(path.join(root, 'require-main'));
require(path.join(root, 'nodebb-global'));
const nconf = require('nconf');
nconf.env({ separator: '__' });
const prestart = require(path.join(root, 'src/prestart'));
prestart.loadConfig(path.join(root, 'config.json'));
const db = require(path.join(root, 'src/database'));

(async () => {
	try {
		await db.init();
		const meta = require(path.join(root, 'src/meta'));
		await meta.configs.init();
		// The maintenance process must not federate profile changes.
		meta.config.activitypubEnabled = 0;
		const user = require(path.join(root, 'src/user'));
		const ids = await db.getSortedSetRange('users:joindate', 0, -1);
		const records = await db.getObjectsFields(ids.map(uid => `user:${uid}`), ['username', 'uniportalId']);
		let changed = 0;
		for (let i = 0; i < records.length; i += 1) {
			const record = records[i];
			if (!record?.uniportalId || record.username === record.uniportalId) { continue; }
			const key = `uniportal:identity:${createHash('sha256').update(record.uniportalId).digest('hex')}`;
			if (Number(await db.getObjectField(key, 'uid')) !== Number(ids[i])) { throw new Error('mapping mismatch'); }
			// Core API validates conflicts and updates slugs, indexes and username history.
			await user.updateProfile(Number(ids[i]), { uid: Number(ids[i]), username: record.uniportalId });
			changed += 1;
		}
		console.log(`Enterprise usernames migrated: ${changed}. User IDs, posts and permissions preserved.`);
	} finally { if (db.pool) { await db.pool.end(); } }
})().then(() => process.exit(0)).catch(() => {
	console.error('Migration stopped: check username availability and identity mapping locally. No credentials printed.');
	process.exit(1);
});
