'use strict';

const { attachmentUrl } = require('./attachments');
const { isDocument } = require('./documents');

function createSummaryMedia({ posts, db, canRead, baseUrl, relativePath = '' }) {
	const origin = new URL(baseUrl).origin;
	const prefix = `${relativePath}/attachments/`;
	return async function previewSummaries(data) {
		const teasers = data.teasers.filter(Boolean);
		if (!teasers.length) { return data; }
		// 摘要已经被转成纯文本，批量读取原文，仅提取首个可访问的媒体附件。
		const originals = await posts.getPostsFields(teasers.map(post => post.pid), ['pid', 'content', 'sourceContent']);
		const byPid = new Map(originals.filter(Boolean).map(post => [String(post.pid), post]));
		await Promise.all(teasers.map(async (teaser) => {
			delete teaser.mediaPreview;
			const post = byPid.get(String(teaser.pid));
			const text = post?.sourceContent || post?.content || '';
			const visited = new Set();
			for (const match of text.matchAll(/https?:\/\/[^\s<>"()[\]`]+|\/[^\s<>"()[\]`]+/g)) {
				let url;
				try { url = new URL(match[0], origin); } catch (_err) { continue; }
				if (url.origin !== origin || !url.pathname.startsWith(prefix)) { continue; }
				const ref = url.pathname.slice(prefix.length).match(/^([a-f0-9-]{36})\/(original|thumbnail)\/[^/]+$/);
				if (!ref || visited.has(ref[1])) { continue; }
				visited.add(ref[1]);
				const record = await db.getObject(`privateAttachment:${ref[1]}`);
				const isVideo = record && /\.(mp4|wmv|webm|ogg)$/i.test(record.name);
				const document = record && isDocument(record);
				if (!record || (!isVideo && !document && !/^image\/(jpeg|png|gif|webp|avif)$/.test(record.mime)) ||
					!await canRead(record, data.uid)) { continue; }
				const variants = JSON.parse(record.variants);
				const variant = !isVideo && !document && variants.thumbnail ? 'thumbnail' : 'original';
				const source = attachmentUrl(relativePath, record.id, variant, record.name);
				teaser.mediaPreview = { url: isVideo || document ? `${source}?poster=1` : source, isVideo,
					isDocument: document, documentUrl: document ? `${source}?preview=1` : '',
					videoUrl: isVideo ? source : '', name: record.name };
				break;
			}
		}));
		return data;
	};
}

module.exports = { createSummaryMedia };
