'use strict';

// 仅切换默认首页；保留板块、主题、用户权限和其他外观设置。
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const requireApp = require('node:module').createRequire(path.join(root, 'package.json'));
requireApp('./require-main');
requireApp('./nodebb-global');
const nconf = requireApp('nconf');
nconf.env({ separator: '__' });
requireApp('./src/prestart').loadConfig(path.resolve(process.env.CONFIG || path.join(root, 'config.json')));
const db = requireApp('./src/database');

async function main() {
	try {
		await db.init();
		const before = await db.getObjectField('config', 'homePageRoute');
		console.log(`默认首页：${before || '未设置'} → recent`);
		if (!process.argv.includes('--apply')) { return; }
		const directory = path.join(process.env.CONFIG_DIR || root, 'backups');
		await fs.mkdir(directory, { recursive: true });
		await fs.writeFile(path.join(directory, `topic-home-before-${Date.now()}.json`),
			`${JSON.stringify({ homePageRoute: before })}\n`, { mode: 0o600, flag: 'wx' });
		await db.setObjectField('config', 'homePageRoute', 'recent');
		console.log('首页已切换，重启后生效；原配置已备份。');
	} finally { await db.close(); }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err.message); process.exit(1); });
