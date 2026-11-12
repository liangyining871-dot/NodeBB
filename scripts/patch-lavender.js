'use strict';

// Compatibility patch for the installed upstream theme; reapplied after npm install.
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function translate(source) {
	return source.replace(/\[\[([^\[\]]+)\]\]/g, (tag, inner) => {
		const parts = inner.split(',').map(value => value.trim());
		const key = parts.shift();
		if (key === 'global:{posts.user.status}') { return '{{tx(concat("global:", posts.user.status))}}'; }
		if (!/^[a-zA-Z0-9/_-]+:[a-zA-Z0-9._-]+$/.test(key)) { throw new Error(`Unsupported translation key in Lavender template: ${key}`); }
		const args = parts.map((value) => {
			const match = value.match(/^\{([./a-zA-Z0-9:_-]+)\}$/);
			if (!match) { throw new Error('Unsupported translation argument in Lavender template'); }
			const variable = match[1];
			return key === 'global:last-edited-by' ? `txEscape(${variable})` : variable;
		});
		return `{{tx(${[JSON.stringify(key), ...args].join(', ')})}}`;
	});
}

async function patch() {
	const theme = path.join(root, 'node_modules/nodebb-theme-lavender');
	let version;
	try { version = JSON.parse(await fs.readFile(path.join(theme, 'package.json'), 'utf8')).version; } catch (err) {
		if (err.code === 'ENOENT') { return; }
		throw err;
	}
	if (version !== '8.1.2') { throw new Error('Lavender version changed; review the compatibility patch before applying it.'); }
	let count = 0;
	async function walk(directory) {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const filename = path.join(directory, entry.name);
			if (entry.isDirectory()) { await walk(filename); } else if (entry.name.endsWith('.tpl')) {
				const original = await fs.readFile(filename, 'utf8');
				const updated = translate(original);
				if (updated !== original) { await fs.writeFile(filename, updated); count += 1; }
			}
		}
	}
	await walk(path.join(theme, 'templates'));
	console.log(`Lavender 8.1.2 translation compatibility: ${count} template files updated.`);
}

module.exports = { translate, patch };
if (require.main === module) { patch().catch((err) => { console.error(err.message); process.exitCode = 1; }); }
