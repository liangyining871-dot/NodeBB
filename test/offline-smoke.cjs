'use strict';

// Run inside the isolated test container, from /usr/src/app (see deploy.md).
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const appRequire = createRequire(`${process.cwd()}/package.json`);
const { Client } = appRequire('pg');
const snapshot = appRequire('./install/docker/appearance.snapshot.json');
const cookies = new Map();
async function request(route, options = {}) {
	const response = await fetch(`http://127.0.0.1:9203${route}`, {
		...options, redirect: 'manual', signal: AbortSignal.timeout(5000),
		headers: { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...options.headers },
	});
	for (const raw of response.headers.getSetCookie()) {
		const part = raw.split(';')[0];
		cookies.set(part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1));
	}
	return response;
}
async function main() {
	let response;
	for (let attempt = 0; attempt < 30; attempt++) {
		try {
			response = await request('/api/config');
			if (response.ok) { break; }
		} catch { /* Startup may still be in progress. */ }
		await new Promise(resolve => setTimeout(resolve, 1000));
	}
	assert.ok(response?.ok, 'forum must start on an internal network');
	const config = await response.json();
	assert.equal(config.siteTitle, process.env.EXPECTED_SITE_TITLE || snapshot.config.title);
	assert.equal(config['brand:logo'], snapshot.config['brand:logo']);
	for (const route of ['/assets/client.css', '/assets/nodebb.min.js', '/assets/brand/huawei-emblem-transparent.png']) {
		const asset = await request(route);
		assert.equal(asset.status, 200, route);
		assert.ok((await asset.arrayBuffer()).byteLength > 100, route);
	}
	const login = await request('/login', {
		method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': config.csrf_token },
		body: new URLSearchParams({ username: 'offline-admin', password: process.env.NODEBB_ADMIN_PASSWORD }),
	});
	assert.ok(login.status >= 200 && login.status < 400, `login status ${login.status}`);
	const authenticated = await (await request('/api/config')).json();
	assert.ok(Number(authenticated.uid) > 0, 'administrator login must work');
	const db = new Client({
		host: process.env.postgres__host, port: Number(process.env.postgres__port),
		database: process.env.postgres__database, user: process.env.postgres__username,
		password: process.env.postgres__password,
	});
	await db.connect();
	try {
		const stored = (await db.query('SELECT data FROM legacy_hash WHERE _key=$1', ['config'])).rows[0].data;
		assert.equal(stored['theme:id'], 'nodebb-theme-lavender');
		const plugins = (await db.query('SELECT value FROM legacy_zset WHERE _key=$1', ['plugins:active'])).rows.map(p => p.value).sort();
		assert.deepEqual(plugins, snapshot.plugins.map(p => p.id).sort());
		const marker = (await db.query('SELECT data FROM legacy_hash WHERE _key=$1', ['deployment:initial-appearance'])).rows[0].data;
		assert.equal(marker.state, 'complete');
	} finally { await db.end(); }
	const { client, bucket } = await appRequire('./plugins/nodebb-plugin-private-attachments/storage').connect();
	const key = 'offline-smoke-test.txt';
	await client.putObject(bucket, key, Buffer.from('offline attachment validation'));
	try {
		const stream = await client.getObject(bucket, key);
		const chunks = [];
		for await (const chunk of stream) { chunks.push(chunk); }
		assert.equal(Buffer.concat(chunks).toString(), 'offline attachment validation');
	} finally { await client.removeObject(bucket, key); }
	await assert.rejects(fetch('https://registry.npmjs.org', { signal: AbortSignal.timeout(3000) }));
	console.log('PASS: offline startup, appearance, assets, administrator login, MinIO IO, and blocked external network');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
