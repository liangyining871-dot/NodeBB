'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(limit = 5, total = 7) {
	const recent = new Map([['7', 7]]);
	const source = Array.from({ length: total }, (_, i) => ({ value: String(i + 1), score: i + 1 }));
	const records = new Map(source.map(t => [t.value, { tid: t.value, deleted: 0, scheduled: false }]));
	const reads = [];
	function range(start, stop) { return [...recent.entries()].sort((a, b) => a[1] - b[1]).slice(start, stop === -1 ? undefined : stop + 1).map(t => t[0]); }
	const db = {
		async getSortedSetRevRangeWithScores(key, start, stop) { reads.push(start); return [...source].reverse().slice(start, stop + 1); },
		async getSortedSetRange(key, start, stop) { return range(start, stop); },
		async sortedSetCard() { return recent.size; },
		async sortedSetAdd(key, scores, values) {
			if (!Array.isArray(values)) { recent.set(String(values), scores); return; }
			values.forEach((value, i) => recent.set(String(value), scores[i]));
		},
		async sortedSetRemove(key, values) { for (const value of Array.isArray(values) ? values : [values]) { recent.delete(String(value)); } },
	};
	const dependencies = {
		winston: { warn() {} }, lodash: require('lodash'), '../database': db, '../posts': {},
		'../topics': { async getTopicsFields(ids) { return ids.map(id => records.get(id)); } },
		'../privileges': {}, '../plugins': { hooks: { async fire(hook, data) { return data; } } },
		'../batch': {}, '../utils': {}, '../meta': {}, '../slugify': {}, '../translator': {}, '../cache': {},
	};
	const categories = { async exists() { return true; }, async getCategoryField() { return limit; }, async setCategoryField(cid, field, value) { limit = value; } };
	for (const file of ['recentreplies.js', 'update.js']) {
		const context = { module: { exports: {} }, require(name) { if (!dependencies[name]) { throw new Error(`Unexpected dependency ${name}`); } return dependencies[name]; } };
		vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/categories', file), 'utf8'), context);
		context.module.exports(categories);
	}
	return { categories, recent, source, records, reads, setLimit(value) { limit = value; } };
}

test('saving increased preview count backfills existing topics in activity order', async () => {
	const f = fixture(1);
	await f.categories.update({ 2: { numRecentReplies: '5' } });
	assert.deepEqual([...f.recent.keys()].sort(), ['3', '4', '5', '6', '7']);
	assert.equal(f.recent.get('6'), 6);
	await f.categories.update({ 2: { numRecentReplies: 2 } });
	assert.deepEqual([...f.recent.keys()].sort(), ['6', '7']);
	await f.categories.update({ 2: { numRecentReplies: 0 } });
	assert.equal(f.recent.size, 0);
});

test('deleted and scheduled topics are excluded, scanning subsequent batches when needed', async () => {
	const f = fixture(5, 110);
	for (let id = 11; id <= 110; id += 1) { f.records.get(String(id)).deleted = id % 2; f.records.get(String(id)).scheduled = id % 2 === 0; }
	await f.categories.rebuildRecentTids(2);
	assert.deepEqual(f.reads, [0, 100]);
	assert.deepEqual([...f.recent.keys()].sort(), ['10', '6', '7', '8', '9']);
});

test('replying to a listed topic preserves the number of previews', async () => {
	const f = fixture();
	await f.categories.rebuildRecentTids(2);
	await f.categories.updateRecentTid(2, '4');
	assert.equal(f.recent.size, 5);
	assert.ok(f.recent.get('4') > f.recent.get('7'));
});

test('new posts serialize with index rebuilding and retain the newest topic', async () => {
	const f = fixture();
	await Promise.all([f.categories.rebuildRecentTids(2), f.categories.updateRecentTid(2, '8')]);
	assert.equal(f.recent.size, 5);
	assert.ok(f.recent.has('8'));
});

test('invalid preview counts are rejected without altering the index', async () => {
	for (const value of [-1, 1.5, 'bad', {}, true]) {
		const f = fixture();
		await assert.rejects(f.categories.update({ 2: { numRecentReplies: value } }), /invalid-data/);
		assert.equal(f.recent.size, 1);
		assert.equal(f.reads.length, 0);
	}
});
