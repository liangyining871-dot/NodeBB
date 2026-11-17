'use strict';

// 仅保存网页链接，不在服务器抓取外部文档或封面。
function webUrl(value, optional = false) {
	if (optional && !value) { return ''; }
	if (typeof value !== 'string' || value.length > 2048) { throw new Error('请填写有效的 HTTP 或 HTTPS 链接'); }
	let url;
	try { url = new URL(value.trim()); } catch (_err) { throw new Error('请填写有效的 HTTP 或 HTTPS 链接'); }
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
		throw new Error('仅支持不含账号密码的 HTTP 或 HTTPS 链接');
	}
	return url.href;
}

function validate(data) {
	if (!Object.hasOwn(data, 'externalUrl')) { return data; }
	data.externalUrl = webUrl(data.externalUrl, true);
	data.externalCover = data.externalUrl ? webUrl(data.externalCover, true) : '';
	return data;
}

function save(payload) {
	const { topic, data } = payload;
	validate(data);
	// 未携带扩展字段的普通编辑保留原值；显式清空链接则恢复普通主题。
	if (Object.hasOwn(data, 'externalUrl')) {
		topic.externalUrl = data.externalUrl;
		topic.externalCover = data.externalCover;
		if (!data.externalUrl) { topic.externalDescription = ''; }
	}
	if (topic.externalUrl && typeof data.content === 'string') {
		topic.externalDescription = data.content
			.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
			.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
			.replace(/<[^>]*>/g, '').replace(/[#*`_>]/g, '').trim().slice(0, 600);
	}
	return payload;
}

function decorate(data) {
	for (const topic of data.topics || []) {
		if (!topic.externalUrl) { continue; }
		try {
			// 模板变量会自动转义，保留原始文本以免链接被二次编码。
			topic.externalLink = {
				url: webUrl(topic.externalUrl),
				description: topic.externalDescription || '',
			};
			if (topic.externalCover) {
				topic.mediaPreview = { url: webUrl(topic.externalCover), name: '文档封面' };
			}
		} catch (_err) { delete topic.externalLink; }
	}
	return data;
}

module.exports = { webUrl, validate, save, decorate };
