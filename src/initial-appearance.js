'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const marker = 'deployment:initial-appearance';

// Called only by setup, never by normal startup or upgrade.
exports.prepare = async function ({ db, snapshotPath, root = path.resolve(__dirname, '..'), force = false }) {
	if (!snapshotPath) { return null; }
	const state = await db.getObjectField(marker, 'state');
	if (!force && (state === 'complete' || (state !== 'pending' && await db.getObjectField('config', 'theme:id')))) {
		return null;
	}
	const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
	if (snapshot.schemaVersion !== 1 || !snapshot.config || !Array.isArray(snapshot.plugins) ||
		!snapshot.plugins.length || !snapshot.plugins.some(p => p.id === snapshot.config['theme:id'])) {
		throw new Error('Invalid initial appearance snapshot');
	}
	if (snapshot.nodebbVersion !== require('../package.json').version) {
		throw new Error('Initial appearance snapshot NodeBB version mismatch');
	}
	for (const plugin of snapshot.plugins) {
		if (!/^nodebb-(?:theme|plugin|widget|rewards)-[a-z0-9-]+$/.test(plugin.id) || !Number.isFinite(plugin.score)) {
			throw new Error('Invalid initial appearance package');
		}
		const pkg = JSON.parse(await fs.readFile(path.join(root, 'node_modules', plugin.id, 'package.json'), 'utf8'));
		if (pkg.version !== plugin.version) { throw new Error(`Initial appearance package version mismatch: ${plugin.id}`); }
	}
	for (const item of snapshot.presentationHashes || []) {
		if (!/^(widgets:[\w./-]+|navigation:enabled:\d+|settings:lavender)$/.test(item._key)) {
			throw new Error('Invalid presentation object namespace');
		}
	}
	await db.setObjectField(marker, 'state', 'pending');
	return snapshot;
};

exports.apply = async function ({ db, meta, snapshot }) {
	if (!snapshot) { return false; }
	if (await db.getObjectField(marker, 'state') === 'complete') { return false; }
	// The theme API also sets the theme paths used by the subsequent setup build.
	await meta.themes.set({ type: 'local', id: snapshot.config['theme:id'] });
	await meta.configs.setMultiple({ ...snapshot.config, ...snapshot.localPolicies });
	await db.delete('plugins:active');
	await db.sortedSetAdd('plugins:active', snapshot.plugins.map(p => p.score), snapshot.plugins.map(p => p.id));
	const oldIds = await db.getSortedSetRange('navigation:enabled', 0, -1);
	for (const id of oldIds) { await db.delete(`navigation:enabled:${id}`); }
	await db.delete('navigation:enabled');
	for (const item of snapshot.presentationHashes || []) {
		await db.delete(item._key);
		await db.setObject(item._key, item.data);
	}
	if (snapshot.navigation?.length) {
		await db.sortedSetAdd('navigation:enabled', snapshot.navigation.map(n => Number(n.score)), snapshot.navigation.map(n => n.value));
	}
	await meta.configs.init();
	// Mark last: a failed import remains pending and setup can retry it.
	await db.setObject(marker, { state: 'complete', appliedAt: new Date().toISOString(), exportedAt: snapshot.exportedAt });
	return true;
};
