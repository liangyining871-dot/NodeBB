'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registrationComplete } = require('../library');

test('middleware clears stale enterprise onboarding but preserves local-account completion', async () => {
	const fs = require('node:fs');
	const path = require('node:path');
	const vm = require('node:vm');
	const redirects = [];
	const deps = {
		'../meta': { config: { requireEmailAddress: 0 } },
		'../plugins': { hooks: { fire: async (hook, data) => ({ ...data, skip: data.req.uid === 2 }) } },
		'../controllers/helpers': { redirect: (res, url) => redirects.push(url) },
		'./helpers': { redirect: (res, url) => redirects.push(url), try: fn => fn },
	};
	const sandbox = { module: { exports: {} }, setImmediate, require: name => deps[name] || {} };
	vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../../src/middleware/user.js'), 'utf8'), sandbox);
	const middleware = {};
	sandbox.module.exports(middleware);
	const req = { path: '/', uid: 2, session: { registration: { uid: 2, updateEmail: true } } };
	await new Promise((resolve, reject) => middleware.registrationComplete(req, {}, resolve).catch(reject));
	assert.equal(req.session.registration, undefined);
	await middleware.registrationComplete({ path: '/register/complete', uid: 2, session: { registration: {} } }, {}, () => assert.fail('should redirect'));
	assert.deepEqual(redirects, ['/']);
	await middleware.registrationComplete({ path: '/', uid: 1, session: { registration: { updateEmail: true } } }, {}, () => assert.fail('local completion should remain'));
	assert.deepEqual(redirects, ['/', '/register/complete']);
});

test('only mapped authenticated enterprise accounts skip account completion', async () => {
	const previous = globalThis.nodebb;
	const lookups = [];
	globalThis.nodebb = { require: () => ({ getObjectField: async (key, field) => {
		lookups.push([key, field]);
		return key === 'user:2' ? 'employee-2' : null;
	} }) };
	try {
		const enterprise = { req: { uid: 2 }, allowed: ['/register/complete'] };
		assert.equal((await registrationComplete(enterprise)).skip, true);
		assert.deepEqual(enterprise.allowed, ['/register/complete']);
		const local = { req: { uid: 1 }, allowed: [] };
		assert.equal((await registrationComplete(local)).skip, undefined);
		const guest = { req: { uid: 0, body: { uid: 2 }, session: { registration: { uid: 2 } } }, allowed: [] };
		assert.equal((await registrationComplete(guest)).skip, undefined);
		assert.equal((await registrationComplete({})).skip, undefined);
		assert.deepEqual(lookups, [['user:2', 'uniportalId'], ['user:1', 'uniportalId']]);
	} finally { globalThis.nodebb = previous; }
});
