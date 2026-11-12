'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
	const row = { name: 'Original category', handle: 'original-category' };
	const checks = [];
	const handleIndex = new Map([['original-category', '1'], ['taken-handle', '2']]);
	const db = {
		async setObjectField(key, field, value) { row[field] = value; },
		async sortedSetRemove(key, value) { if (key === 'categoryhandle:cid') { handleIndex.delete(value); } },
		async sortedSetAdd(key, score, value) { if (key === 'categoryhandle:cid') { handleIndex.set(value, score); } },
	};
	const dependencies = {
		'../database': db,
		'../meta': { async slugTaken(value) { checks.push(value); if (!value) { throw new Error('[[error:invalid-data]]'); } return handleIndex.has(value); } },
		'../utils': { isNumber: value => Number.isFinite(Number(value)) },
		'../slugify': value => value.toLowerCase().replaceAll(' ', '-'),
		'../translator': { async translate(value) { return value; } },
		'../plugins': { hooks: { async fire(hook, data) { return data; } } },
		'../cache': { del() {} },
	};
	const context = { module: { exports: {} }, require(name) { if (!dependencies[name]) { throw new Error(`Unexpected dependency: ${name}`); } return dependencies[name]; } };
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/categories/update.js'), 'utf8'), context);
	const categories = { async exists() { return true; }, async getCategoryField(cid, field) { return row[field]; }, async setCategoryField(cid, field, value) { row[field] = value; }, async rebuildRecentTids() {} };
	context.module.exports(categories);
	return { categories, row, checks, handleIndex };
}

test('cleared handle preserves original identifier while other category fields save', async () => {
	for (const handle of ['', '   ', '\t\r\n']) {
		const f = fixture();
		await f.categories.update({ 1: { name: 'Updated category', handle, numRecentReplies: 5 } });
		assert.equal(f.row.name, 'Updated category');
		assert.equal(f.row.numRecentReplies, 5);
		assert.equal(f.row.handle, 'original-category');
		assert.equal(f.handleIndex.get('original-category'), '1');
		assert.equal(f.checks.length, 0);
	}
});

test('nonempty handles retain uniqueness validation and index updates', async () => {
	const f = fixture();
	await assert.rejects(f.categories.update({ 1: { handle: 'taken-handle' } }), /category.handle-taken/);
	assert.equal(f.row.handle, 'original-category');
	await f.categories.update({ 1: { handle: ' new-handle ' } });
	assert.equal(f.row.handle, 'new-handle');
	assert.equal(f.handleIndex.has('original-category'), false);
	assert.equal(f.handleIndex.get('new-handle'), '1');
	const count = f.checks.length;
	await f.categories.update({ 1: { handle: 'new-handle' } });
	assert.equal(f.checks.length, count);
});

test('malformed handle types are rejected instead of being persisted', async () => {
	for (const handle of [null, undefined, {}, [], 123, false]) {
		const f = fixture();
		await assert.rejects(f.categories.update({ 1: { handle } }), /invalid-data/);
		assert.equal(f.row.handle, 'original-category');
	}
});
