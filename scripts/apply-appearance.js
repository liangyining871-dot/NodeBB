'use strict';

// Explicit repair for an already initialized site. Default mode is read-only.
const fs = require('node:fs/promises');
const path = require('node:path');
const nconf = require('nconf');
const root = path.resolve(__dirname, '..');
const requireApp = require('node:module').createRequire(path.join(root, 'package.json'));
requireApp('./require-main');
requireApp('./nodebb-global');

async function main() {
	nconf.env({ separator: '__' });
	const prestart = requireApp('./src/prestart');
	prestart.loadConfig(path.resolve(root, process.env.CONFIG || 'config.json'));
	prestart.setupWinston();
	const db = requireApp('./src/database');
	try {
		await db.init();
		const meta = requireApp('./src/meta');
		await meta.configs.init();
		const snapshotPath = process.env.INITIAL_APPEARANCE_SNAPSHOT || path.join(root, 'install/docker/appearance.snapshot.json');
		const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
		const active = await db.getSortedSetRangeWithScores('plugins:active', 0, -1);
		console.log(JSON.stringify({
			mode: process.argv.includes('--apply') ? 'apply' : 'diagnose',
			database: nconf.get('postgres:database'),
			currentTheme: await db.getObjectField('config', 'theme:id'),
			targetTheme: snapshot.config['theme:id'],
			uniportalPluginActive: active.some(p => p.value === 'nodebb-plugin-sso-uniportal'),
			UNIPORTAL_ENABLED: process.env.UNIPORTAL_ENABLED || 'unset',
			UNIPORTAL_AUTO_LOGIN: process.env.UNIPORTAL_AUTO_LOGIN || 'unset',
			requireEmailAddress: await db.getObjectField('config', 'requireEmailAddress'),
		}, null, 2));
		if (process.env.UNIPORTAL_ENABLED === 'true') {
			try { requireApp('./plugins/nodebb-plugin-sso-uniportal/library').config(); } catch {
				throw new Error('Uniportal configuration is incomplete or invalid; check URLs, client credentials, scope and callback. No configuration values are printed.');
			}
		}
		if (!process.argv.includes('--apply')) {
			console.log('Read-only diagnosis. Stop the forum and use --apply to back up and import the snapshot.');
			return;
		}
		// Back up precisely the existing config namespaces before changing them.
		const navigation = await db.getSortedSetRangeWithScores('navigation:enabled', 0, -1);
		const keys = [...new Set(['config', 'deployment:initial-appearance',
			...navigation.map(n => `navigation:enabled:${n.value}`),
			...(snapshot.presentationHashes || []).map(h => h._key)])];
		const backup = { createdAt: new Date().toISOString(), plugins: active, navigation, objects: await db.getObjects(keys), keys };
		const directory = path.join(root, 'backups');
		await fs.mkdir(directory, { recursive: true });
		const file = path.join(directory, `appearance-before-${Date.now()}.json`);
		await fs.writeFile(file, `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
		const appearance = requireApp('./src/initial-appearance');
		const prepared = await appearance.prepare({ db, snapshotPath, force: true });
		await appearance.apply({ db, meta, snapshot: prepared });
		console.log(`Applied appearance. Sensitive configuration backup: ${file}`);
		console.log('Windows: rebuild with node --env-file=.env .\\nodebb build --series, then restart. No npm install is performed by this command.');
	} finally {
		await db.close();
	}
}

// NodeBB modules register long-lived background timers even in a CLI process.
main().then(() => process.exit(0)).catch((err) => { console.error(err.message); process.exit(1); });
