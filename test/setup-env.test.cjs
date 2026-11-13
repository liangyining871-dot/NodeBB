'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/install.js'), 'utf8');
const setupEnv = source.slice(source.indexOf('function checkSetupFlagEnv()'), source.indexOf('function checkCIFlag()'));
function run(env) {
	const install = {};
	vm.runInNewContext(`${setupEnv}\ncheckSetupFlagEnv();`, {
		install, nconf: { get: key => key === 'database' ? 'postgres' : undefined },
		winston: { info() {}, error() {} },
		process: { env, exit: code => { throw new Error(`exit:${code}`); } },
	});
	return install;
}
test('Docker config path and existing database env preserve interactive admin setup', () => {
	assert.equal(run({ CONFIG: '/opt/config/config.json', database: 'postgres', INITIAL_APPEARANCE_SNAPSHOT: '/snapshot.json' }).values, undefined);
	assert.equal(run({ NODEBB_CONFIG: '/opt/config/config.json' }).values, undefined);
});
test('explicit admin environment still provisions credentials and ignores unrelated flags', () => {
	const { values } = run({ CONFIG: '/opt/config/config.json', NODEBB_ADMIN_USERNAME: 'test-admin', NODEBB_ADMIN_PASSWORD: 'test-password', NODEBB_ADMIN_EMAIL: 'test@example.invalid', NODEBB_ADDITIONAL_PLUGINS: 'ignored' });
	assert.equal(values['admin:username'], 'test-admin');
	assert.equal(values['admin:password:confirm'], 'test-password');
	assert.equal(Object.hasOwn(values, 'undefined'), false);
});
test('incomplete automated credentials fail with a nonzero status', () => {
	assert.throws(() => run({ NODEBB_ADMIN_USERNAME: 'test-admin' }), /exit:1/);
});

test('administrator username and password are sufficient without a mailbox', () => {
	for (const extra of [{}, { NODEBB_ADMIN_EMAIL: '' }]) {
		const { values } = run({ CONFIG: '/opt/config/config.json', NODEBB_ADMIN_USERNAME: 'admin', NODEBB_ADMIN_PASSWORD: 'test-password', ...extra });
		assert.equal(values['admin:username'], 'admin');
		assert.equal(values['admin:password:confirm'], 'test-password');
		assert.ok(!values['admin:email']);
	}
});

test('blank email creates a password-based administrator without email verification', async () => {
	const createAdmin = source.slice(source.indexOf('async function createAdmin()'), source.indexOf('async function createGlobalModeratorsGroup()'));
	for (const interactive of [false, true]) {
		let created;
		const credentials = { username: 'admin', password: 'test-password', 'password:confirm': 'test-password', email: '' };
		const User = { isPasswordValid() {}, create: async (data, opts) => { created = { data, opts }; return 1; } };
		const Groups = { join: async () => {}, show: async () => {}, ownership: { grant: async () => {} } };
		const result = vm.runInNewContext(`${createAdmin}\ncreateAdmin();`, {
			require: name => name === './user' ? User : Groups,
			install: { values: interactive ? undefined : { 'admin:username': 'admin', 'admin:password': 'test-password', 'admin:password:confirm': 'test-password' } },
			nconf: { get: () => undefined }, winston: { warn() {} },
			prompt: { get: async questions => {
				const email = questions.find(q => q.name === 'email');
				assert.equal(email.required, false);
				assert.equal(email.pattern.test(''), true);
				return credentials;
			} },
		});
		await result;
		assert.equal(created.data.email, '');
		assert.equal(created.opts.emailVerification, 'skip');
		assert.equal(created.data.password, 'test-password');
	}
});
