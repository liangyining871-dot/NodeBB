'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function patchSource(source) {
	const updateSizeMessage = value => value.replace("'[[error:file-too-big, ' + config.maximumFileSize + ']]'",
		"'[[error:file-too-big, ' + (transport.maximumFileSize ? Math.floor(transport.maximumFileSize(files[i]) / 1024) : config.maximumFileSize) + ']]'");
	if (source.includes('filter:composer.uploadTransport')) { return updateSizeMessage(source); }
	const replacements = [
		['\t\tconst files = [...params.files];', '\t\tconst files = [...params.files];\n\t\tconst transport = { files, post_uuid: params.post_uuid, route: params.route };\n\t\t$(window).trigger(\'filter:composer.uploadTransport\', [transport]);'],
		['files[i].size > parseInt(config.maximumFileSize, 10) * 1024', 'files[i].size > (transport.maximumFileSize ? transport.maximumFileSize(files[i]) : parseInt(config.maximumFileSize, 10) * 1024)'],
		['\t\t\t$(this).ajaxSubmit({', '\t\t\tconst submit = transport.submit || (options => $(this).ajaxSubmit(options));\n\t\t\tsubmit({'],
	];
	for (const [before, after] of replacements) {
		if (!source.includes(before)) { throw new Error('Composer 上传实现已变化，请复核上传扩展接口'); }
		source = source.replace(before, after);
	}
	return updateSizeMessage(source);
}

async function patch() {
	const root = path.resolve(__dirname, '../node_modules/nodebb-plugin-composer-default');
	let pkg;
	try { pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')); } catch (err) {
		if (err.code === 'ENOENT') { return; }
		throw err;
	}
	if (pkg.version !== '11.0.16') { throw new Error('Composer 版本已变化，请复核上传扩展接口'); }
	const filename = path.join(root, 'static/lib/composer/uploads.js');
	const source = await fs.readFile(filename, 'utf8');
	const updated = patchSource(source);
	if (updated !== source) { await fs.writeFile(filename, updated); }
	console.log('Composer 上传扩展接口检查通过');
}

module.exports = { patchSource, patch };
if (require.main === module) { patch().catch(err => { console.error(err.message); process.exitCode = 1; }); }
