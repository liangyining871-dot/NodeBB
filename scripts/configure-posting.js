'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const requireApp = require('node:module').createRequire(path.join(root, 'package.json'));
const nconf = requireApp('nconf');
requireApp('./require-main');
requireApp('./nodebb-global');

async function main() {
	nconf.env({ separator: '__' });
	const prestart = requireApp('./src/prestart');
	prestart.loadConfig(path.resolve(root, process.env.CONFIG || path.join(process.env.CONFIG_DIR || root, 'config.json')));
	prestart.setupWinston();
	const db = requireApp('./src/database');
	try {
		await db.init();
		const meta = requireApp('./src/meta');
		const privileges = requireApp('./src/privileges');
		await meta.configs.init();
		const before = {
			database: nconf.get('postgres:database'),
			postQueue: meta.config.postQueue,
			registeredUserFileUploads: await privileges.global.canGroup('upload:post:file', 'registered-users'),
			allowedFileExtensions: meta.config.allowedFileExtensions,
			maximumFileSizeKB: meta.config.maximumFileSize,
		};
		console.log(JSON.stringify(before, null, 2));
		if (!process.argv.includes('--apply')) {
			console.log('Read-only diagnosis. Stop the forum and use --apply to disable post review and grant registered-user file uploads.');
			return;
		}
		const backupDirectory = path.join(process.env.CONFIG_DIR || root, 'backups');
		await fs.mkdir(backupDirectory, { recursive: true });
		const backup = path.join(backupDirectory, `posting-before-${Date.now()}.json`);
		await fs.writeFile(backup, `${JSON.stringify(before, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
		await requireApp('./src/deployment-posting').apply({ meta, privileges });
		console.log(`Applied. Backup: ${backup}. Restart the forum and refresh the browser. File type/size limits remain unchanged.`);
	} finally { await db.close(); }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err.message); process.exit(1); });
