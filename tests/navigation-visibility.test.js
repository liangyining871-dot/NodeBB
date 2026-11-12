'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { navigationHeader } = require('../plugins/nodebb-plugin-sso-uniportal/library');

test('only enterprise ordinary users lose users/groups navigation; admin and local accounts keep it', async () => {
	const before = globalThis.nodebb;
	try {
		globalThis.nodebb = { require(name) {
			return name === 'nconf' ? { get() { return ''; } } : { async getObjectField(key) { return key === 'user:2' ? 'enterprise-account' : null; } };
		} };
		const routes = ['/users', '/groups/', '/recent', '/user/employee', 'https://other.example/users'];
		const make = (uid, user = {}) => ({ req: { uid }, templateData: { user, navigation: routes.map(route => ({ route })) } });
		const ordinary = make(2);
		await navigationHeader(ordinary);
		assert.deepEqual(ordinary.templateData.navigation.map(n => n.route), routes.slice(2));
		for (const data of [make(1), make(0), make(2, { isAdmin: true }), make(2, { isGlobalMod: true }), make(2, { isMod: true })]) {
			await navigationHeader(data);
			assert.equal(data.templateData.navigation.length, routes.length);
		}
	} finally { globalThis.nodebb = before; }
});

test('navigation filtering supports subpath deployments without editing permissions', async () => {
	const before = globalThis.nodebb;
	try {
		globalThis.nodebb = { require(name) { return name === 'nconf' ? { get() { return '/forum'; } } : { async getObjectField() { return 'enterprise-account'; } }; } };
		const data = { req: { uid: 2 }, templateValues: { user: {}, navigation: ['/forum/users?tab=online', '/forum/groups', '/forum/recent', '/users'].map(route => ({ route })) } };
		await navigationHeader(data);
		assert.deepEqual(data.templateValues.navigation.map(n => n.route), ['/forum/recent', '/users']);
	} finally { globalThis.nodebb = before; }
});

test('ordinary chat entry is hidden, admin keeps it, notification branding is contained', async () => {
	const before = globalThis.nodebb;
	try {
		globalThis.nodebb = { require() { return { async getObjectField() { return null; } }; } };
		const ordinary = { req: { uid: 3 }, templateData: { user: {}, canChat: true, customCSS: '.existing { color: red; }' } };
		await navigationHeader(ordinary);
		assert.equal(ordinary.templateData.canChat, false);
		assert.ok(ordinary.templateData.customCSS.includes('#mobile-chats [component="chat/icon"]'));
		assert.ok(ordinary.templateData.customCSS.includes('.existing { color: red; }'));
		assert.ok(ordinary.templateData.customCSS.includes('object-fit: contain'));
		assert.ok(ordinary.templateData.customCSS.includes('[data-nid] img.avatar'));
		assert.equal(ordinary.templateData.useCustomCSS, true);
		const admin = { req: { uid: 1 }, templateData: { user: { isAdmin: true }, canChat: true } };
		await navigationHeader(admin);
		assert.equal(admin.templateData.canChat, true);
		assert.ok(admin.templateData.customCSS.includes('object-fit: contain'));
		assert.ok(!admin.templateData.customCSS.includes('#mobile-chats'));
	} finally { globalThis.nodebb = before; }
});
