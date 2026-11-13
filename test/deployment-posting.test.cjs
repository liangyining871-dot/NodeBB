'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const posting = require('../src/deployment-posting');

test('posting repair disables review and grants only registered-user file uploads', async () => {
	const config = { postQueue: 1, maximumFileSize: 2048, allowedFileExtensions: 'mp4,png' };
	const grants = [];
	await posting.apply({
		meta: { config, configs: { set: async (key, value) => { config[key] = value; } } },
		privileges: { global: { give: async (...args) => grants.push(args) } },
	});
	assert.equal(config.postQueue, 0);
	assert.equal(config.maximumFileSize, 2048);
	assert.equal(config.allowedFileExtensions, 'mp4,png,pdf,doc,docx,xls,xlsx,ppt,pptx,csv,md');
	assert.deepEqual(grants, [[['groups:upload:post:file'], 'registered-users']]);
});

test('new installations grant file uploads to registered users but not guests', async () => {
	const fs = require('node:fs');
	const path = require('node:path');
	const vm = require('node:vm');
	const source = fs.readFileSync(path.join(__dirname, '../src/install.js'), 'utf8');
	const fn = source.slice(source.indexOf('async function giveGlobalPrivileges()'), source.indexOf('async function giveWorldPrivileges()'));
	const grants = [];
	await vm.runInNewContext(`${fn}\ngiveGlobalPrivileges();`, {
		require: () => ({ global: { give: async (privileges, group) => grants.push({ privileges, group }) } }),
	});
	assert.ok(grants.find(g => g.group === 'registered-users').privileges.includes('groups:upload:post:file'));
	assert.equal(grants.find(g => g.group === 'guests').privileges.includes('groups:upload:post:file'), false);
	for (const grant of grants) {
		assert.equal(new Set(grant.privileges).size, grant.privileges.length, `duplicate privileges for ${grant.group}`);
	}
});
