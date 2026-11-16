'use strict';

function returnPath(candidate, origin) {
	if (typeof candidate !== 'string' || !candidate.trim()) { return '/'; }
	try {
		const raw = candidate.trim();
		if (!raw.startsWith('/') && !/^https?:\/\//i.test(raw)) { return '/'; }
		const decoded = decodeURIComponent(raw);
		if ([raw, decoded].some(value => value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value))) { return '/'; }
		const url = new URL(raw, origin);
		const check = new URL(decoded, origin);
		if (url.origin !== origin || check.origin !== origin || url.username || url.password || check.username || check.password) { return '/'; }
		const blocked = /^\/(?:login|logout|register|reset|auth|api|assets|attachments)(?:\/|$)/i;
		if (blocked.test(url.pathname) || blocked.test(check.pathname)) { return '/'; }
		return url.pathname + url.search + url.hash;
	} catch { return '/'; }
}

module.exports = { returnPath };
