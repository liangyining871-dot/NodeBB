'use strict';

// Explicit deployment policy; upload handlers continue to enforce permissions,
// size limits, authentication and private-object access.
exports.apply = async function ({ meta, privileges }) {
	await meta.configs.set('postQueue', 0);
	const allowed = String(meta.config?.allowedFileExtensions || '').trim();
	// An empty allowlist means unrestricted types; do not narrow that policy.
	if (allowed) {
		const extensions = new Set(allowed.split(',').map(value => value.trim().replace(/^\./, '').toLowerCase()).filter(Boolean));
		for (const extension of ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'md']) { extensions.add(extension); }
		await meta.configs.set('allowedFileExtensions', [...extensions].join(','));
	}
	await privileges.global.give(['groups:upload:post:file'], 'registered-users');
};
