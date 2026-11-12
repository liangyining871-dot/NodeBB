'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { expiration, lifetime, createAccessControl } = require('../plugins/nodebb-plugin-sso-uniportal/session-policy');

test('email reminder is disabled for enterprise users, leaving local account settings unchanged', async () => {
	const before = globalThis.nodebb;
	try {
		globalThis.nodebb = { require() { return { async getObjectField(key) { return key === 'user:2' ? 'enterprise-login' : null; } }; } };
		const { emailConfig } = require('../plugins/nodebb-plugin-sso-uniportal/library');
		assert.equal((await emailConfig({ uid: 2, emailPrompt: 1 })).emailPrompt, 0);
		assert.equal((await emailConfig({ uid: 1, emailPrompt: 1 })).emailPrompt, 1);
		assert.equal((await emailConfig({ uid: 0, emailPrompt: 1 })).emailPrompt, 1);
	} finally { globalThis.nodebb = before; }
});

function fixture() {
	let time = 1000;
	const revoked = [];
	const notices = [];
	const env = { UNIPORTAL_ENABLED: 'true', UNIPORTAL_REQUIRE_LOGIN: 'true' };
	const db = { async getObjectFields(key) { return key === 'user:2' ? { uid: 2, uniportalId: 'employee-1' } : key === 'user:1' ? { uid: 1 } : null; } };
	const user = { auth: { async revokeSession(sid, uid) { revoked.push({ sid, uid }); } } };
	const timers = [];
	const policy = createAccessControl({ db, user, env, now: () => time,
		helpers: { redirect(res, target) { res.status(307).json(target); } },
		sockets: { server: { in(room) { return { emit(event) { notices.push({ room, event }); }, disconnectSockets() {} }; } } },
		schedule(fn, delay) { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; }, unschedule() {},
	});
	function req(url, uid = 0, auth, method = 'GET') {
		const request = { originalUrl: url, method, uid, user: uid ? { uid } : undefined, sessionID: 'session', session: auth ? { uniportalAuth: auth } : {}, logout(done) { request.user = undefined; request.session = {}; done(); } };
		return request;
	}
	async function run(request) {
		const result = { next: false, status: 200, headers: {} };
		const res = { set(key, value) { result.headers[key] = value; return this; }, status(code) { result.status = code; return this; }, json(data) { result.body = data; return this; } };
		await policy.http(request, res, () => { result.next = true; });
		return result;
	}
	return { policy, req, run, env, revoked, notices, timers, advance() { time = 2000; } };
}

test('absolute expiry uses 30-minute default and shorter expires_in, never slides', () => {
	assert.equal(expiration({}, 1000, {}), 1801000);
	assert.equal(expiration({ expires_in: '600' }, 1000, {}), 601000);
	assert.equal(expiration({ expires_in: 7200 }, 1000, {}), 1801000);
	assert.throws(() => expiration({ expires_in: 0 }, 1000, {}));
	assert.throws(() => expiration({ expires_in: true }, 1000, {}));
	assert.throws(() => lifetime({ UNIPORTAL_SESSION_TTL_SECONDS: 'bad' }));
});

test('guest deep links redirect; data and write APIs return 401, local=1 cannot bypass', async () => {
	const f = fixture();
	for (const url of ['/', '/topic/3', '/category/3', '/users', '/topic/3?local=1', '/assets/uploads/files/private.pdf']) {
		const result = await f.run(f.req(url));
		assert.equal(result.status, 307);
		assert.equal(result.body.external, '/auth/uniportal');
	}
	for (const [url, method] of [['/api/topic/3', 'GET'], ['/api/v3/topics', 'POST'], ['/api/v3/posts/3/vote', 'PUT']]) {
		const result = await f.run(f.req(url, 0, null, method));
		assert.equal(result.status, 401);
		assert.equal(result.body.response.loginUrl, '/auth/uniportal');
	}
});

test('login/callback/CSRF and public assets remain available; local admin stays logged in', async () => {
	const f = fixture();
	for (const url of ['/auth/uniportal', '/auth/uniportal/callback?code=not-logged', '/login?local=1', '/api/login?local=1', '/api/config', '/assets/client.js', '/assets/brand/huawei-emblem-transparent.png', '/assets/uploads/system/site-logo.png']) {
		assert.equal((await f.run(f.req(url))).next, true);
	}
	assert.equal((await f.run(f.req('/login', 0, null, 'POST'))).next, true);
	assert.equal((await f.run(f.req('/admin', 1))).next, true);
	assert.equal((await f.run(f.req('/api/v3/topics', 1, null, 'POST'))).next, true);
	assert.equal(f.revoked.length, 0);
});

test('enterprise sessions expire at the exact boundary; legacy and mismatched sessions fail closed', async () => {
	const f = fixture();
	const auth = { uid: 2, expiresAt: 2000 };
	assert.equal((await f.run(f.req('/topic/3', 2, auth))).next, true);
	assert.equal(auth.expiresAt, 2000);
	f.advance();
	const expired = f.req('/api/v3/topics', 2, auth, 'POST');
	assert.equal((await f.run(expired)).status, 401);
	assert.equal(expired.uid, 0);
	assert.equal(expired.user, undefined);
	assert.deepEqual(f.revoked[0], { sid: 'session', uid: 2 });
	assert.ok(f.notices.some(n => n.event === 'event:uniportal.expired'));
	assert.equal((await f.run(f.req('/topic/3', 2))).status, 307);
	assert.equal((await f.run(f.req('/topic/3', 2, { uid: 1, expiresAt: 3000 }))).status, 307);
	assert.equal((await f.run(f.req('/login?local=1', 2))).next, true);
});

test('WebSocket messages reject expired sessions and idle sockets are disconnected on deadline', async () => {
	const f = fixture();
	const events = [];
	const socket = { uid: 2, request: { session: { uniportalAuth: { uid: 2, expiresAt: 2000 } }, signedCookies: {} }, emit(event) { events.push(event); }, disconnect() { events.push('disconnect'); }, once() {} };
	await f.policy.socketConnect({ socket });
	assert.equal(f.timers[0].delay, 1000);
	await f.policy.socketValidate({ socket, session: { passport: { user: 2 }, uniportalAuth: { uid: 2, expiresAt: 2000 } } });
	f.advance();
	await assert.rejects(f.policy.socketValidate({ socket, session: { passport: { user: 2 }, uniportalAuth: { uid: 2, expiresAt: 2000 } } }));
	assert.ok(events.includes('disconnect'));
	events.length = 0;
	f.timers[0].fn();
	await new Promise(resolve => setImmediate(resolve));
	assert.ok(events.includes('disconnect'));
	await assert.rejects(f.policy.socketValidate({ socket, session: {} }));
});

test('policy disabled does not alter existing forum behavior', async () => {
	const f = fixture();
	f.env.UNIPORTAL_REQUIRE_LOGIN = 'false';
	assert.equal((await f.run(f.req('/topic/3'))).next, true);
});

test('real Passport session rotation preserves deadline; HTTP access expires without sliding and local admin still works', async () => {
	const express = require('express');
	const session = require('express-session');
	const passport = new (require('passport').Passport)();
	const cookieFetch = require('fetch-cookie').default;
	const app = express();
	const f = fixture();
	passport.serializeUser((account, done) => done(null, account.uid));
	passport.deserializeUser((uid, done) => done(null, { uid }));
	app.use(session({ secret: 'isolated-session-policy-test', resave: false, saveUninitialized: false }));
	app.use(passport.initialize());
	app.use(passport.session());
	app.use(f.policy.http);
	app.get('/auth/uniportal/callback', (req, res, next) => {
		req.session.uniportalAuth = { uid: 2, authenticatedAt: 1000, expiresAt: 2000 };
		req.login({ uid: 2 }, { keepSessionInfo: true }, (err) => {
			if (err) { return next(err); }
			res.json({ preserved: req.session.uniportalAuth?.expiresAt === 2000 });
		});
	});
	app.post('/login', (req, res, next) => req.login({ uid: 1 }, err => (err ? next(err) : res.json({ uid: 1 }))));
	app.get('/api/topic/3', (req, res) => res.json({ uid: req.user.uid, expiresAt: req.session.uniportalAuth?.expiresAt }));
	const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
	try {
		const client = cookieFetch(fetch);
		const base = `http://127.0.0.1:${server.address().port}`;
		assert.equal((await client(`${base}/api/topic/3`)).status, 401);
		const callback = await client(`${base}/auth/uniportal/callback`);
		assert.equal((await callback.json()).preserved, true);
		const active = await client(`${base}/api/topic/3`);
		assert.deepEqual(await active.json(), { uid: 2, expiresAt: 2000 });
		f.advance();
		assert.equal((await client(`${base}/api/topic/3`)).status, 401);
		assert.equal((await client(`${base}/api/topic/3`)).status, 401);
		assert.equal((await client(`${base}/login`, { method: 'POST' })).status, 200);
		assert.equal((await (await client(`${base}/api/topic/3`)).json()).uid, 1);
	} finally {
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	}
});
