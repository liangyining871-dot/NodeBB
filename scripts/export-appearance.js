'use strict';

// Read-only snapshot of deployment appearance; never exports DB credentials or users.
const fs = require('node:fs/promises');
const path = require('node:path');
const { Client } = require('pg');

async function main() {
	const root = path.resolve(__dirname, '..');
	const local = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
	const postgres = { ...local.postgres };
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith('postgres__')) { postgres[key.slice(10)] = value; }
	}
	const client = new Client({
		host: postgres.host, port: postgres.port, user: postgres.username,
		password: postgres.password, database: postgres.database,
		ssl: String(postgres.ssl) === 'true', connectionTimeoutMillis: 5000,
	});
	try {
		await client.connect();
		await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
		const { rows } = await client.query('SELECT data FROM legacy_hash WHERE _key = $1', ['config']);
		if (!rows.length) { throw new Error('Local forum has not been initialized'); }
		const source = rows[0].data;
		const fields = /^(theme:|brand:|og:image$|title$|title:|titleLayout$|browserTitle$|description$|keywords$|themeColor$|backgroundColor$|bootswatchSkin$|defaultLang$|autoDetectLang$|homePage|showSiteTitle$|allowUserHomePage$|disableCustomUserSkins$|useCustom|customCSS$|customHTML$|customJS$|useBSVariables$|bsVariables$|renderedCustomCSS$|topicsPerPage$|postsPerPage$|categoriesPerPage$|teaserPost$|showPostPreviewsOnHover$|showFullnameAsDisplayName$|disableSignatures$|showPostUploadsAsThumbnails$|updateUrlWithPostIndex$|tinycon)/;
		const config = Object.fromEntries(Object.entries(source).filter(([key]) => fields.test(key)));
		const active = (await client.query('SELECT value, score FROM legacy_zset WHERE _key = $1 ORDER BY score, value', ['plugins:active'])).rows;
		const plugins = [];
		for (const item of active) {
			const pkg = JSON.parse(await fs.readFile(path.join(root, 'node_modules', item.value, 'package.json'), 'utf8'));
			plugins.push({ id: item.value, version: pkg.version, score: Number(item.score) });
		}
		// Only presentation namespaces; no arbitrary plugin settings or authentication secrets.
		const hashes = (await client.query("SELECT _key, data FROM legacy_hash WHERE _key LIKE 'widgets:%' OR _key LIKE 'navigation:enabled:%' OR _key = 'settings:lavender' ORDER BY _key")).rows;
		const navigation = (await client.query('SELECT value, score FROM legacy_zset WHERE _key = $1 ORDER BY score, value', ['navigation:enabled'])).rows;
		await client.query('ROLLBACK');
		const snapshot = {
			schemaVersion: 1, exportedAt: new Date().toISOString(), nodebbVersion: local.version || require('../package.json').version,
			targetUrl: 'http://aixsilicon.developers.hisilicon.com:9203',
			config, plugins, presentationHashes: hashes, navigation,
			localPolicies: Object.fromEntries(['activitypubEnabled', 'postDelay', 'newbiePostDelay', 'initialPostDelay'].map(key => [key, source[key]])),
		};
		const destination = path.join(root, 'install/docker/appearance.snapshot.json');
		await fs.writeFile(destination, `${JSON.stringify(snapshot, null, 2)}\n`);
		console.log(`Exported ${config['theme:id']}: ${plugins.length} active packages, ${hashes.length} presentation objects to install/docker/appearance.snapshot.json`);
	} finally {
		await client.end();
	}
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
