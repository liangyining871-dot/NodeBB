'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
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

async function main() {
	const count = Number(process.argv[2] || 10);
	if (!Number.isInteger(count) || count < 1 || count > 100) { throw new Error('Invalid count'); }
	const file = path.join(__dirname, 'accounts.json');
	let accounts;
	try { accounts = JSON.parse(await fs.readFile(file, 'utf8')); } catch (err) {
		if (err.code !== 'ENOENT') { throw err; }
		accounts = [];
	}
	if (!Array.isArray(accounts)) { throw new Error('Invalid accounts file'); }
	await db.init();
	const meta = require(path.join(root, 'src/meta'));
	await meta.configs.init();
	// This maintenance process neither federates nor sends welcome messages.
	meta.config.activitypubEnabled = 0;
	meta.config.welcomeNotification = '';
	const user = require(path.join(root, 'src/user'));
	const targets = [];
	for (let i = 1; i <= count; i += 1) {
		const username = `test${i}`;
		const uid = await user.getUidByUsername(username);
		const saved = accounts.find(a => a.username === username);
		if (uid && (!saved?.password || Number(saved.uid) !== Number(uid) || Number(await user.getUserField(uid, 'loadTestAccount')) !== 1)) {
			throw new Error('Existing account is not owned by this script');
		}
		targets.push({ username, uid, saved });
	}
	let created = 0;
	for (const target of targets) {
		if (target.uid) { continue; }
		const account = target.saved || { username: target.username, password: `${randomBytes(24).toString('base64url')}!9aA` };
		if (!target.saved) { accounts.push(account); }
		// Save the generated password before creating its account; never print it.
		await fs.writeFile(file, JSON.stringify(accounts, null, 2), { mode: 0o600 });
		await user.checkUsername(target.username);
		const uid = await user.create({ username: target.username, password: account.password }, { emailVerification: 'skip' });
		if (await user.getUserField(uid, 'username') !== target.username) { throw new Error('Username conflict'); }
		await user.setUserField(uid, 'loadTestAccount', 1);
		account.uid = Number(uid);
		await fs.writeFile(file, JSON.stringify(accounts, null, 2), { mode: 0o600 });
		if (await user.isAdministrator(uid) || await user.isGlobalModerator(uid)) { throw new Error('Unexpected elevated privileges'); }
		created += 1;
	}
	const config = JSON.parse(await fs.readFile(path.join(__dirname, 'load.example.json'), 'utf8'));
	config.baseUrl = new URL(nconf.get('url')).origin;
	config.users = count;
	config.accountsFile = 'accounts.json';
	await fs.writeFile(path.join(__dirname, 'load.local.json'), JSON.stringify(config, null, 2));
	console.log(`Created ${created} ordinary accounts; ${count - created} existing test accounts reused (test1 through test${count}).`);
	console.log('Passwords saved only in tests/accounts.json. Authenticated load configuration: tests/load.local.json.');
}

main().then(async () => { if (db.pool) { await db.pool.end(); } process.exit(0); }).catch(async () => {
	console.error('Account setup stopped. Inspect account conflicts or partial creation locally; existing passwords were not reset. No credentials printed.');
	if (db.pool) { await db.pool.end(); }
	process.exit(1);
});
