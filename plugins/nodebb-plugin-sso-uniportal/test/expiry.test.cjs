'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createAccessControl } = require('../session-policy');

test('expired enterprise login returns to OAuth, while explicit admin login remains available', async () => {
	const redirects = [];
	const revoked = [];
	const policy = createAccessControl({
		env: { UNIPORTAL_ENABLED: 'true', UNIPORTAL_REQUIRE_LOGIN: 'true', UNIPORTAL_AUTO_LOGIN: 'true' },
		db: { getObjectFields: async key => key === 'user:2' ? ({ uid: 2, uniportalId: 'employee-2' }) : ({ uid: 1 }) },
		user: { auth: { revokeSession: async (...args) => revoked.push(args) } },
		helpers: { redirect: (res, target) => redirects.push(target.external) }, sockets: {}, now: () => 100,
	});
	const res = { set() { return this; }, status(code) { this.code = code; return this; }, json(data) { this.body = data; } };
	let next = 0;
	const expired = { method: 'GET', originalUrl: '/login', uid: 2, user: { uid: 2 }, sessionID: 'test-session', query: {}, session: { uniportalAuth: { uid: 2, expiresAt: 50 } }, logout(done) { this.user = null; done(); } };
	await policy.http(expired, res, () => next++);
	assert.deepEqual(redirects, ['/auth/uniportal']);
	assert.deepEqual(revoked, [['test-session', 2]]);
	assert.equal(next, 0);
	for (const query of [{ local: '1' }, { uniportal: 'failed' }]) {
		await policy.http({ method: 'GET', originalUrl: '/login', uid: 0, query }, res, () => next++);
	}
	assert.equal(next, 2);
	await policy.http({ method: 'GET', originalUrl: '/admin', uid: 1, session: {} }, res, () => next++);
	assert.equal(next, 3);
	await policy.http({ method: 'POST', originalUrl: '/api/v3/topics', uid: 0 }, res, () => assert.fail('must not replay writes'));
	assert.equal(res.code, 401);
	assert.equal(res.body.response.loginUrl, '/auth/uniportal');
});

test('client handles invalid sessions and server disconnects, including a stalled draft module', async () => {
	const source = fs.readFileSync(path.join(__dirname, '../static/session.js'), 'utf8');
	for (const event of ['event:invalid_session', 'disconnect']) {
		const handlers = new Map();
		const timers = [];
		const redirects = [];
		const context = {
			config: { relative_path: '/forum', uniportalSession: { uid: 2, expiresAt: 1000, serverNow: 100 } },
			app: { user: { uid: 2 }, require: async () => ({ on() {} }) },
			socket: { on: (name, handler) => handlers.set(name, handler) },
			document: { querySelector: () => ({}), addEventListener() {} },
			require() {}, // Simulate a composer module that never finishes loading.
			performance: { now: () => 0 }, addEventListener() {},
			location: { replace: target => redirects.push(target) },
			setTimeout: (callback, delay) => { timers.push({ callback, delay }); },
			fetch: async () => ({ status: 200 }), $: () => ({ on() {} }),
		};
		vm.runInNewContext(source, context);
		handlers.get(event)('io server disconnect');
		assert.equal(redirects.length, 0);
		timers.find(timer => timer.delay === 2000).callback();
		await new Promise(setImmediate);
		assert.deepEqual(redirects, ['/forum/auth/uniportal']);
		handlers.get('event:uniportal.expired')();
		await new Promise(setImmediate);
		assert.equal(redirects.length, 1);
	}
});
