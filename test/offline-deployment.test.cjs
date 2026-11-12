'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('offline rebuild is rejected before touching a database or assets', async () => {
	const build = require('../src/meta/build');
	const previous = process.env.OFFLINE_DEPLOYMENT;
	process.env.OFFLINE_DEPLOYMENT = 'true';
	try {
		await assert.rejects(build.build(true), /Offline deployment/);
	} finally {
		if (previous === undefined) { delete process.env.OFFLINE_DEPLOYMENT; } else { process.env.OFFLINE_DEPLOYMENT = previous; }
	}
});

test('offline dependency repair fails before executing a package manager', () => {
	const childProcess = require('node:child_process');
	const install = require('../src/cli/package-install');
	const original = childProcess.execSync;
	const previous = process.env.OFFLINE_DEPLOYMENT;
	let executed = false;
	childProcess.execSync = () => { executed = true; };
	process.env.OFFLINE_DEPLOYMENT = 'true';
	try {
		assert.throws(() => install.installAll(), /Offline deployment/);
		assert.equal(executed, false);
	} finally {
		childProcess.execSync = original;
		if (previous === undefined) { delete process.env.OFFLINE_DEPLOYMENT; } else { process.env.OFFLINE_DEPLOYMENT = previous; }
	}
});
