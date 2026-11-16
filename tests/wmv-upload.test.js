'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/controllers/uploads.js'), 'utf8');

function validate({ ext = 'asf', blocked = [] } = {}) {
	const start = source.indexOf('async function validateFileExtension(');
	const end = source.indexOf("require('../promisify')", start);
	return vm.runInNewContext(`${source.slice(start, end)}; validateFileExtension`, {
		path, file: { allowedExtensions: () => ['.wmv'], blockedExtensions: () => blocked },
		fileTypeFromFile: async () => ({ ext }),
	});
}

test('WMV 的 ASF 容器识别与白名单兼容，仍尊重实际格式黑名单', async () => {
	await validate()({ name: '视频.wmv', path: 'file' });
	await assert.rejects(validate({ blocked: ['.asf'] })({ name: '视频.wmv', path: 'file' }));
	await assert.rejects(validate({ ext: 'exe' })({ name: '视频.wmv', path: 'file' }));
	await assert.rejects(validate()({ name: 'file.asf', path: 'file' }));
});
