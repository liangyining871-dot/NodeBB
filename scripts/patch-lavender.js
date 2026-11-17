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

// 首页摘要保留文字，另显示首个媒体附件；该补丁随安装和镜像构建重复应用。
function addMediaPreview(source) {
	if (!source.includes('data-document-src=')) {
		source = source.replace('data-video-src=', 'data-document-src="{./mediaPreview.documentUrl}" data-video-src=');
	}
	source = source.replace('component="category/posts" class=', 'component="category/posts" data-tid="{./tid}" class=');
	if (source.includes('category-media-preview')) { return source; }
	const marker = '<hr class="mb-2 mt-1" />';
	if (!source.includes(marker)) { throw new Error('Lavender category preview template changed'); }
	return source.replace(marker, `${marker}
				{{{ if ./mediaPreview }}}
				<a class="category-media-preview" href="{config.relative_path}/topic/{./topic.slug}{{{ if ./index }}}/{./index}{{{ end }}}" data-document-src="{./mediaPreview.documentUrl}" data-video-src="{./mediaPreview.videoUrl}" aria-label="查看媒体所在帖子">
					<img src="{./mediaPreview.url}" alt="{./mediaPreview.name}" loading="lazy" />
					{{{ if ./mediaPreview.isVideo }}}<span class="category-media-play" aria-hidden="true">▶</span>{{{ end }}}
				</a>
				{{{ end }}}`);
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
				let updated = translate(original);
				if (entry.name === 'category_child.tpl') { updated = addMediaPreview(updated); }
				if (entry.name === 'topics_list.tpl') {
					// 默认页和板块页共用原生主题列表入口，仅替换为统一卡片模板。
					updated = await fs.readFile(path.join(root,
						'plugins/nodebb-plugin-private-attachments/templates/topic-cards.tpl'), 'utf8');
				}
				if (updated !== original) { await fs.writeFile(filename, updated); count += 1; }
			}
		}
	}
	await walk(path.join(theme, 'templates'));
	// 覆盖继承的搜索模板，保持输入框常驻，无需改动原生搜索脚本。
	const searchTemplate = path.join(theme, 'templates/partials/header/search.tpl');
	await fs.mkdir(path.dirname(searchTemplate), { recursive: true });
	await fs.writeFile(searchTemplate, await fs.readFile(path.join(root,
		'plugins/nodebb-plugin-private-attachments/templates/header-search.tpl'), 'utf8'));
	console.log(`Lavender 8.1.2 translation compatibility: ${count} template files updated.`);
}

module.exports = { translate, addMediaPreview, patch };
if (require.main === module) { patch().catch((err) => { console.error(err.message); process.exitCode = 1; }); }
