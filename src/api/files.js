'use strict';

const fs = require('fs').promises;
const file = require('../file');

const filesApi = module.exports;

// path assertion and traversal guarding logic is in src/middleware/assert.js

filesApi.delete = async (_, { path }) => {
	const stored = await file.storage('delete', path);
	if (!stored.handled) { await fs.unlink(path); }
};

filesApi.createFolder = async (_, { path }) => await file.createFolder(path);
