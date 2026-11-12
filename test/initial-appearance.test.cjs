'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const appearance = require('../src/initial-appearance');
const snapshot = require('../install/docker/appearance.snapshot.json');
const snapshotPath = path.resolve(__dirname, '../install/docker/appearance.snapshot.json');

function fixture() {
	const objects = new Map();
	const sets = new Map([['plugins:active', ['nodebb-theme-harmony', 'nodebb-plugin-web-push']], ['navigation:enabled', ['99']]]);
	const db = {
		getObjectField: async (key, field) => objects.get(key)?.[field],
		setObjectField: async (key, field, value) => objects.set(key, { ...objects.get(key), [field]: value }),
		setObject: async (key, value) => objects.set(key, value),
		delete: async (key) => { objects.delete(key); sets.delete(key); },
		getSortedSetRange: async key => sets.get(key) || [],
		sortedSetAdd: async (key, scores, values) => sets.set(key, values),
	};
	const meta = {
		themes: { set: async theme => db.setObjectField('config', 'theme:id', theme.id) },
		configs: { setMultiple: async data => db.setObject('config', { ...objects.get('config'), ...data }), init: async () => {} },
	};
	return { db, meta, objects, sets };
}

test('fresh setup imports the actual snapshot and does not overwrite later changes', async () => {
	const f = fixture();
	const prepared = await appearance.prepare({ db: f.db, snapshotPath });
	assert.equal(f.objects.get('deployment:initial-appearance').state, 'pending');
	assert.equal(await appearance.apply({ ...f, snapshot: prepared }), true);
	assert.equal(f.objects.get('config')['theme:id'], 'nodebb-theme-lavender');
	assert.equal(f.objects.get('config').title, 'AIXSILICON广场');
	assert.deepEqual(f.sets.get('plugins:active'), snapshot.plugins.map(p => p.id));
	assert.equal(f.sets.get('plugins:active').includes('nodebb-plugin-web-push'), false);
	assert.deepEqual(f.objects.get('widgets:global'), snapshot.presentationHashes.find(h => h._key === 'widgets:global').data);
	await f.db.setObjectField('config', 'title', 'Production title');
	assert.equal(await appearance.prepare({ db: f.db, snapshotPath }), null);
	assert.equal(await appearance.apply({ ...f, snapshot }), false);
	assert.equal(f.objects.get('config').title, 'Production title');
});

test('existing installation and unconfigured local setup are untouched', async () => {
	const f = fixture();
	await f.db.setObjectField('config', 'theme:id', 'nodebb-theme-persona');
	assert.equal(await appearance.prepare({ db: f.db, snapshotPath: 'does-not-exist' }), null);
	assert.equal(await appearance.prepare({ db: f.db }), null);
	assert.equal(f.objects.has('deployment:initial-appearance'), false);
});

test('failed import stays pending and can be retried', async () => {
	const f = fixture();
	const prepared = await appearance.prepare({ db: f.db, snapshotPath });
	const set = f.meta.configs.setMultiple;
	f.meta.configs.setMultiple = async () => { throw new Error('simulated failure'); };
	await assert.rejects(appearance.apply({ ...f, snapshot: prepared }), /simulated failure/);
	assert.equal(f.objects.get('deployment:initial-appearance').state, 'pending');
	f.meta.configs.setMultiple = set;
	assert.ok(await appearance.prepare({ db: f.db, snapshotPath }));
	await appearance.apply({ ...f, snapshot: prepared });
	assert.equal(f.objects.get('deployment:initial-appearance').state, 'complete');
});

test('missing packaged dependency fails before writing initialization marker', async () => {
	const f = fixture();
	await assert.rejects(appearance.prepare({ db: f.db, snapshotPath, root: path.join(__dirname, 'missing-root') }), /ENOENT/);
	assert.equal(f.objects.has('deployment:initial-appearance'), false);
});
