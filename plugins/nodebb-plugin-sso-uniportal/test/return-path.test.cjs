'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { returnPath } = require('../return-path');

test('OAuth return targets exclude auth loops, APIs, binary responses and external redirects', () => {
	const origin = 'https://forum.example';
	for (const target of ['/login', '/login?local=1', '/auth/uniportal/callback', '/logout', '/register/complete', '/api/topic/1', '/attachments/id/file.mp4', '//evil.test', '/%2f/evil.test', 'https://evil.test/topic/1', '/\\evil.test', 'javascript:alert(1)', 'relative', null]) {
		assert.equal(returnPath(target, origin), '/', String(target));
	}
	assert.equal(returnPath('/topic/1/test?page=2#4', origin), '/topic/1/test?page=2#4');
	assert.equal(returnPath('https://forum.example/category/2', origin), '/category/2');
});
