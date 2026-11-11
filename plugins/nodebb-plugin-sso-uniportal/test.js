'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createService, config, postJSON } = require('./library');
const browserRequest = sessionID => ({ sessionID, session: { save(done) { done(); } } });

function fixture() {
	const objects = new Map();
	const users = new Map();
	let created = 0;
	let time = 1000;
	let posts = 0;
	const db = {
		async getObject(k) { return objects.has(k) ? { ...objects.get(k) } : null; },
		async setObject(k, v) { objects.set(k, { ...objects.get(k), ...v }); },
		async expire() {},
		async incrObjectField(k, f) { const v = objects.get(k) || {}; v[f] = Number(v[f] || 0) + 1; objects.set(k, v); return v[f]; },
	};
	const user = {
		async create(data, opts) { assert.equal(data.password, undefined); assert.equal(data.email, undefined); assert.equal(opts.emailVerification, 'skip'); const uid = ++created; users.set(uid, { ...data }); return uid; },
		async setUserField(uid, k, v) { users.get(uid)[k] = v; },
		async getUserField(uid, k) { return users.get(uid)?.[k]; },
		async setSetting(uid, k, v) { users.get(uid)[k] = v; },
		async exists(uid) { return users.has(uid); },
		bans: { async unbanIfExpired() {} },
		async updateProfile(uid, data) { Object.assign(users.get(uid), data); },
	};
	const service = createService({ db, user, now: () => time, post: async () => (++posts % 2 ? { access_token: 'test' } : { uid: 'employee-1', displayName: 'cn=张三,ou=team' }) });
	const c = { AUTHORIZE_URL: 'http://localhost/authorize', TOKEN_URL: 'http://localhost/token', USERINFO_URL: 'http://localhost/userinfo', REDIRECT_URI: 'http://localhost:9203/auth/uniportal/callback', client: 'token-client', authClient: 'auth-client', secret: 'test', scope: 'test' };
	return { service, c, users, objects, user, db, created: () => created, advance: () => { time += 300001; } };
}

test('first login, concurrent callbacks, repeat login and name synchronization', async () => {
	const f = fixture();
	const results = await Promise.all(Array.from({ length: 10 }, () => f.service.identity({ uid: 'employee-1', displayName: 'cn=张三,ou=team' })));
	assert.equal(f.created(), 1);
	assert.ok(results.every(r => r.uid === 1));
	await f.service.identity({ uid: 'employee-1', displayNameCn: '李四' });
	assert.equal(f.users.get(1).fullname, '李四');
	assert.equal(f.users.get(1).uniportalId, 'employee-1');
	assert.equal(f.users.get(1).administrator, undefined);
	await f.service.identity({ uid: 'employee-2', displayNameCn: '李四' });
	assert.equal(f.created(), 2);
});

test('browser binding, atomic replay protection and expiry', async () => {
	const f = fixture();
	const url = new URL(await f.service.begin(browserRequest('browser'), f.c));
	assert.equal(url.searchParams.get('client_id'), 'auth-client');
	const query = { state: url.searchParams.get('state'), code: 'code' };
	await assert.rejects(f.service.complete({ sessionID: 'other', query }, f.c), err => err.uniportalStage === 'browser');
	const results = await Promise.allSettled([1, 2].map(() => f.service.complete({ sessionID: 'browser', query }, f.c)));
	assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
	const expired = new URL(await f.service.begin(browserRequest('browser'), f.c));
	f.advance();
	await assert.rejects(f.service.complete({ sessionID: 'browser', query: { state: expired.searchParams.get('state'), code: 'code' } }, f.c));
});

test('provider denial consumes state; malformed identity and interrupted provisioning fail closed', async () => {
	const f = fixture();
	const url = new URL(await f.service.begin(browserRequest('browser'), f.c));
	const req = { sessionID: 'browser', query: { state: url.searchParams.get('state'), error: 'denied' } };
	await assert.rejects(f.service.complete(req, f.c));
	req.query = { state: req.query.state, code: 'code' };
	await assert.rejects(f.service.complete(req, f.c));
	await assert.rejects(f.service.identity({ uid: {} }));
	f.user.create = async () => { throw new Error('interrupted'); };
	await assert.rejects(f.service.identity({ uid: 'pending' }));
	await assert.rejects(f.service.identity({ uid: 'pending' }));
	assert.equal(f.created(), 0);
});

test('disabled plugin leaves local login intact; incomplete config fails', async () => {
	assert.throws(() => config({}));
	const strategies = [];
	assert.equal(await require('./library').auth(strategies), strategies);
});

test('POST JSON wire format, no redirects, provider failures are redacted', async () => {
	const original = global.fetch;
	try {
		global.fetch = async (url, options) => {
			assert.equal(url, 'https://enterprise.example/token');
			assert.equal(options.method, 'POST');
			assert.equal(options.redirect, 'error');
			assert.equal(options.headers['Content-Type'], 'application/json');
			assert.deepEqual(JSON.parse(options.body), { client_secret: 'sensitive-test-value' });
			return new Response(JSON.stringify({ access_token: 'mock-token' }));
		};
		assert.deepEqual(await postJSON('https://enterprise.example/token', { client_secret: 'sensitive-test-value' }), { access_token: 'mock-token' });
		for (const response of [new Response('secret-response', { status: 500 }), new Response('invalid-json'), new Response('[]'), new Response('x'.repeat(65537))]) {
			global.fetch = async () => response;
			await assert.rejects(postJSON('https://enterprise.example/token', {}), err => !err.message.includes('secret-response') && err.message.includes('Enterprise login failed'));
		}
	} finally { global.fetch = original; }
});

test('deleted, mismatched and banned mapped users cannot authenticate', async () => {
	const f = fixture();
	await f.service.identity({ uid: 'employee-1' });
	f.users.get(1).banned = 1;
	await assert.rejects(f.service.identity({ uid: 'employee-1' }));
	f.users.get(1).banned = 0;
	f.users.get(1).uniportalId = 'other';
	await assert.rejects(f.service.identity({ uid: 'employee-1' }));
	f.users.delete(1);
	await assert.rejects(f.service.identity({ uid: 'employee-1' }));
	assert.equal(f.created(), 1);
});

test('enabled hook registers Passport routes and redirects failed callbacks safely', async () => {
	const f = fixture();
	const beforeEnv = { ...process.env };
	const beforeNodebb = globalThis.nodebb;
	const beforeFetch = global.fetch;
	let registered;
	const passport = { Strategy: require('passport').Strategy, use(strategy) { registered = strategy; } };
	const redirects = [];
	try {
		for (const [key, value] of Object.entries({ ENABLED: 'true', AUTHORIZE_URL: f.c.AUTHORIZE_URL, TOKEN_URL: f.c.TOKEN_URL, USERINFO_URL: f.c.USERINFO_URL, REDIRECT_URI: f.c.REDIRECT_URI, CLIENT_ID: f.c.client, CLIENT_SECRET: f.c.secret, SCOPE: f.c.scope })) {
			process.env[`UNIPORTAL_${key}`] = value;
		}
		globalThis.nodebb = { require(name) { return { passport, winston: { warn() {} }, './src/database': f.db, './src/user': f.user, './src/controllers/helpers': { redirect(res, target) { redirects.push(target); } } }[name]; } };
		const strategies = await require('./library').auth([]);
		assert.equal(strategies[0].callbackURL, '/auth/uniportal/callback');
		assert.equal(strategies[0].checkState, false); // plugin supplies the stronger, one-use state check
		assert.equal(strategies[0].failureUrl, '/login?local=1&uniportal=failed');
		process.env.UNIPORTAL_AUTO_LOGIN = 'true';
		const redirectGuest = require('./library').redirectGuest;
		for (const originalUrl of ['/', '/login', '/api/', '/api/login']) {
			await redirectGuest({ req: { method: 'GET', uid: 0, query: {}, originalUrl, path: '/categories' }, res: {} });
		}
		assert.deepEqual(redirects, Array(4).fill({ external: '/auth/uniportal' }));
		for (const overrides of [{ uid: 1 }, { user: { uid: 1 } }, { query: { local: '1' } }, { originalUrl: '/auth/uniportal/callback' }, { originalUrl: '/assets/client.js' }, { originalUrl: '/topic/1' }, { method: 'POST' }]) {
			await redirectGuest({ req: { method: 'GET', uid: 0, query: {}, originalUrl: '/', ...overrides }, res: {} });
		}
		assert.equal(redirects.length, 4);
		process.env.UNIPORTAL_AUTO_LOGIN = 'false';
		await redirectGuest({ req: { method: 'GET', query: {}, originalUrl: '/' }, res: {} });
		assert.equal(redirects.length, 4);
		const url = await new Promise((resolve, reject) => {
			registered.redirect = resolve;
			registered.fail = () => reject(new Error('unexpected failure'));
			registered.authenticate({ ...browserRequest('browser'), path: '/auth/uniportal', protocol: 'http', get: () => 'localhost:9203' });
		});
		assert.ok(new URL(url).searchParams.get('state'));
		const wrongHostRedirect = await new Promise((resolve) => {
			registered.redirect = resolve;
			registered.authenticate({ path: '/auth/uniportal', sessionID: 'browser', protocol: 'http', get: () => '127.0.0.1:9203' });
		});
		assert.equal(wrongHostRedirect, 'http://localhost:9203/auth/uniportal');
		// An existing admin session must not determine the enterprise user's UID.
		await f.user.create({ username: 'admin' }, { emailVerification: 'skip' });
		let requests = 0;
		global.fetch = async (address, options) => {
			requests += 1;
			const payload = JSON.parse(options.body);
			assert.equal(payload.client_id, 'token-client');
			if (address === f.c.TOKEN_URL) {
				assert.equal(payload.grant_type, 'authorization_code');
				assert.equal(payload.redirect_uri, f.c.REDIRECT_URI);
				return new Response(JSON.stringify({ access_token: 'test-token' }));
			}
			assert.equal(address, f.c.USERINFO_URL);
			assert.equal(payload.access_token, 'test-token');
			return new Response(JSON.stringify({ uid: 'employee-1', displayName: 'cn=企业用户,ou=team' }));
		};
		const authenticated = await new Promise((resolve, reject) => {
			registered.success = resolve;
			registered.fail = () => reject(new Error('unexpected callback failure'));
			registered.authenticate({ path: '/auth/uniportal/callback', sessionID: 'browser', user: { uid: 1 }, session: {}, query: { state: new URL(url).searchParams.get('state'), code: 'test-code' } });
		});
		assert.deepEqual(authenticated, { uid: 2 });
		assert.equal(f.users.get(1).username, 'admin');
		assert.equal(f.users.get(1).uniportalId, undefined);
		assert.equal(f.users.get(2).fullname, '企业用户');
		assert.equal(f.users.get(2).showfullname, 1);
		assert.equal(requests, 2);
		await new Promise((resolve, reject) => {
			registered.fail = resolve;
			registered.error = reject;
			registered.success = () => reject(new Error('unexpected success'));
			registered.authenticate({ path: '/auth/uniportal/callback', sessionID: 'browser', query: { state: 'invalid' } });
		});
	} finally {
		globalThis.nodebb = beforeNodebb;
		global.fetch = beforeFetch;
		for (const key of Object.keys(process.env).filter(k => k.startsWith('UNIPORTAL_'))) { delete process.env[key]; }
		Object.assign(process.env, beforeEnv);
	}
});

test('enterprise display names respect privacy; local admin is unchanged; failure page explains safe stages', async () => {
	const before = globalThis.nodebb;
	const meta = { config: {} };
	try {
		globalThis.nodebb = { require(name) {
			return {
				'./src/meta': meta,
				'./src/utils': { stripBidiControls: value => value },
				'./src/database': { async getObjectsFields(keys, fields) {
					return fields.includes('fullname') ? [{ fullname: 'Local admin' }, { uniportalId: 'employee-1', fullname: '企业姓名' }, { uniportalId: 'employee-2', fullname: '私密姓名' }] : [{}, { showfullname: 1 }, { showfullname: 0 }];
				} },
			}[name];
		} };
		const users = [{ uid: 1, displayname: 'admin' }, { uid: 2, displayname: 'up-123' }, { uid: 3, displayname: 'up-456' }];
		await require('./library').displayUsers(users);
		assert.deepEqual(users.map(u => u.displayname), ['admin', '企业姓名', 'up-456']);
		assert.equal(users[1].uniportalId, undefined);
		meta.config.hideFullname = 1;
		const hidden = [{ uid: 2, displayname: 'up-123' }];
		await require('./library').displayUsers(hidden);
		assert.equal(hidden[0].displayname, 'up-123');
		const message = await require('./library').loginMessage({ req: { query: { uniportal: 'failed' }, session: { uniportalFailure: 'browser' } }, templateData: {} });
		assert.ok(message.templateData.error.includes('会话不匹配'));
		const unsafe = await require('./library').loginMessage({ req: { query: { uniportal: 'failed' }, session: { uniportalFailure: 'DO_NOT_EXPOSE' } }, templateData: {} });
		assert.ok(!unsafe.templateData.error.includes('DO_NOT_EXPOSE'));
	} finally { globalThis.nodebb = before; }
});

test('real HTTP redirect persists a fresh session cookie and binds callbacks with saveUninitialized:false', async () => {
	const express = require('express');
	const session = require('express-session');
	const f = fixture();
	const app = express();
	app.use(session({ secret: 'isolated-test-session-secret', resave: false, saveUninitialized: false, cookie: { sameSite: 'lax' } }));
	app.get('/start', async (req, res) => { res.redirect(await f.service.begin(req, f.c)); });
	app.get('/callback', async (req, res) => {
		try { res.json(await f.service.complete(req, f.c)); } catch (err) { res.status(400).json({ stage: err.uniportalStage }); }
	});
	const server = await new Promise((resolve, reject) => {
		const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
		instance.on('error', reject);
	});
	try {
		const base = `http://127.0.0.1:${server.address().port}`;
		const start = await fetch(`${base}/start`, { redirect: 'manual' });
		assert.equal(start.status, 302);
		const cookies = start.headers.getSetCookie();
		assert.equal(cookies.length, 1);
		const cookie = cookies[0].split(';')[0];
		const state = new URL(start.headers.get('location')).searchParams.get('state');
		const callback = `${base}/callback?${new URLSearchParams({ state, code: 'mock-code' })}`;
		const otherBrowser = await fetch(callback);
		assert.equal(otherBrowser.status, 400);
		assert.equal((await otherBrowser.json()).stage, 'browser');
		const success = await fetch(callback, { headers: { Cookie: cookie } });
		assert.equal(success.status, 200);
		assert.deepEqual(await success.json(), { uid: 1 });
		const replay = await fetch(callback, { headers: { Cookie: cookie } });
		assert.equal(replay.status, 400);
		assert.equal((await replay.json()).stage, 'replayed');
		assert.equal(f.created(), 1);
	} finally {
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	}
});

test('session persistence failure prevents authorization and creates no state', async () => {
	const f = fixture();
	await assert.rejects(f.service.begin({ session: { save(done) { done(new Error('session store unavailable')); } } }, f.c));
	assert.equal(f.objects.size, 0);
});
