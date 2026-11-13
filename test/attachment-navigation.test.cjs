'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/src/ajaxify.js'), 'utf8');
const check = source.slice(source.indexOf('ajaxify.check ='), source.indexOf('ajaxify.go ='));

test('attachment clicks use browser file navigation instead of requesting an API page', () => {
	for (const prefix of ['', '/forum']) {
		const ajaxify = {};
		class Anchor {
			constructor(href) { this.href = href; }
			getAttribute(name) { return name === 'href' ? this.href : null; }
			toString() { return this.href; }
		}
		vm.runInNewContext(check, {
			ajaxify, Element: Anchor, URL, console,
			document: { location: { origin: 'http://forum.test' } },
			window: { location: { origin: 'http://forum.test' } },
			config: { relative_path: prefix },
			utils: { isInternalURI: url => url.origin === 'http://forum.test' },
		});
		for (const suffix of ['file.txt', 'video.mp4?_=123', 'document.pdf']) {
			const route = `${prefix}/attachments/6f09e98c-9711-4aa0-94b5-c51e3d1f2b70/original/${suffix}`;
			assert.equal(ajaxify.check(new Anchor(route)), false);
			assert.equal(ajaxify.check(new Anchor(`http://forum.test${route}`)), false);
		}
		assert.equal(ajaxify.check(new Anchor(`${prefix}/topic/1/test`)), true);
	}
});
