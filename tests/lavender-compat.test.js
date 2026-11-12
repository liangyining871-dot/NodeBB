'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const benchpress = require('benchpressjs');
const { translate } = require('../scripts/patch-lavender');

test('Lavender labels compile into translation calls, including parameters and dynamic keys', async () => {
	const source = '[[category:new-topic-button]] [[global:votes]] [[global:posts]] [[global:views]] [[category:x-more-categories, {subCategoriesLeft}]] [[global:last-edited-by, {posts.editor.username}]] [[global:{posts.user.status}]]';
	const updated = translate(source);
	assert.ok(!updated.includes('[['));
	assert.ok(updated.includes('txEscape(posts.editor.username)'));
	assert.ok(updated.includes('concat("global:", posts.user.status)'));
	assert.equal(translate(updated), updated);
	const compiled = await benchpress.precompile(updated, { filename: 'lavender-labels.tpl' });
	assert.ok(compiled.includes('category:new-topic-button'));
	assert.ok(!compiled.includes('[[category:new-topic-button]]'));
});
