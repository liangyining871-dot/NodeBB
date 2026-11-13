'use strict';

// Explicit deployment policy; upload handlers continue to enforce permissions,
// allowed types, size limits, authentication and private-object access.
exports.apply = async function ({ meta, privileges }) {
	await meta.configs.set('postQueue', 0);
	await privileges.global.give(['groups:upload:post:file'], 'registered-users');
};
