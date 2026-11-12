'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { expiration, lifetime, createAccessControl } = require('./session-policy');
const hash = value => createHash('sha256').update(value).digest('hex');
const failure = (stage = 'authentication') => Object.assign(new Error('Enterprise login failed. Please start again or contact the administrator.'), { uniportalStage: stage });
const failureMessages = {
	state: '登录请求无效，请重新点击企业登录。',
	browser: '登录浏览器会话不匹配，请允许本站 Cookie，并从同一地址重新发起登录。',
	expired: '登录请求已过期，请重新登录。',
	replayed: '此登录回调已使用，请重新登录。',
	authorization: '企业授权未完成，请重新登录。',
	token: '企业授权码换取凭据失败，请联系管理员检查认证配置。',
	profile: '企业用户资料获取失败或格式不符，请联系管理员。',
	identity: '企业用户映射或论坛账户处理失败，请联系管理员核查。',
	authentication: '企业登录未完成，请重新登录或联系管理员。',
};

async function atStage(stage, operation) {
	try { return await operation(); } catch { throw failure(stage); }
}

function config(env = process.env) {
	const get = key => (env[`UNIPORTAL_${key}`] || '').trim();
	const c = { client: get('CLIENT_ID'), secret: get('CLIENT_SECRET'), scope: get('SCOPE'), authClient: get('AUTH_CLIENT_ID') || get('CLIENT_ID') };
	for (const key of ['AUTHORIZE_URL', 'TOKEN_URL', 'USERINFO_URL', 'REDIRECT_URI']) {
		const url = new URL(get(key));
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) { throw failure(); }
		c[key] = url.toString();
	}
	if (!c.client || !c.secret || !c.scope) { throw failure(); }
	lifetime(env);
	if (new URL(c.REDIRECT_URI).pathname !== '/auth/uniportal/callback') { throw failure(); }
	return c;
}

function createService({ db, user, post = postJSON, now = Date.now }) {
	// One NodeBB worker only. Persistent pending markers also prevent retries after a crash
	// from silently creating a second account. Never remove a pending marker automatically.
	const queues = new Map();
	async function identity(profile) {
		if (typeof profile.uid !== 'string' || !profile.uid.trim() || profile.uid.length > 256) { throw failure(); }
		const external = profile.uid.trim();
		const key = `uniportal:identity:${hash(external)}`;
		const previous = queues.get(key) || Promise.resolve();
		const task = previous.catch(() => {}).then(async () => {
			const match = typeof profile.displayName === 'string' && profile.displayName.match(/cn=([^,]+)/);
			const name = [match && match[1], profile.displayNameCn, profile.displayNameEn, external].find(v => typeof v === 'string' && v.trim()).trim().slice(0, 255);
			let record = await db.getObject(key);
			let uid = record && Number(record.uid);
			if (!uid) {
				if (record) { throw failure(); }
				// Validate availability before reserving provisioning; never attach to an
				// existing local account with the same username.
				await user.checkUsername(external);
				if (await db.incrObjectField(key, 'claim') !== 1) { throw failure(); }
				await db.setObject(key, { pending: 1 });
				uid = await user.create({ username: external, fullname: name }, { emailVerification: 'skip', uniportal: true });
				await user.setUserField(uid, 'uniportalId', external);
				await db.setObject(key, { uid, pending: 0 });
				await user.setSetting(uid, 'showfullname', 1);
			}
			if (!await user.exists(uid) || await user.getUserField(uid, 'uniportalId') !== external) { throw failure(); }
			await user.bans.unbanIfExpired([uid]);
			if (Number(await user.getUserField(uid, 'banned'))) { throw failure(); }
			await user.updateProfile(uid, { uid, username: external, fullname: name });
			return { uid };
		});
		queues.set(key, task);
		try { return await task; } finally { if (queues.get(key) === task) { queues.delete(key); } }
	}
	return {
		identity,
		async begin(req, c) {
			// NodeBB uses saveUninitialized:false. A DB-only state does not cause a
			// session cookie to be issued, so persist a session mutation before leaving.
			req.session.uniportalStarted = randomBytes(16).toString('hex');
			await new Promise((resolve, reject) => req.session.save(err => (err ? reject(err) : resolve())));
			const state = randomBytes(32).toString('hex');
			const key = `uniportal:state:${hash(state)}`;
			await db.setObject(key, { browser: hash(req.sessionID), expires: now() + 300000, consumed: 0 });
			await db.expire(key, 600);
			const url = new URL(c.AUTHORIZE_URL);
			url.search = new URLSearchParams({ client_id: c.authClient, response_type: 'code', redirect_uri: c.REDIRECT_URI, scope: c.scope, display: 'page', state }).toString();
			return url.toString();
		},
		async complete(req, c) {
			const { state, code, error } = req.query;
			if (typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state)) { throw failure('state'); }
			const key = `uniportal:state:${hash(state)}`;
			const record = await db.getObject(key);
			if (!record) { throw failure('expired'); }
			if (record.browser !== hash(req.sessionID)) { throw failure('browser'); }
			if (Number(record.expires) <= now()) { throw failure('expired'); }
			if (await db.incrObjectField(key, 'consumed') !== 1) { throw failure('replayed'); }
			if (error !== undefined || typeof code !== 'string' || !code.trim() || code.length > 4096) { throw failure('authorization'); }
			const issuedAt = now();
			const token = await atStage('token', () => post(c.TOKEN_URL, { client_id: c.client, client_secret: c.secret, redirect_uri: c.REDIRECT_URI, grant_type: 'authorization_code', code }));
			if (typeof token.access_token !== 'string' || !token.access_token) { throw failure('token'); }
			const expiresAt = await atStage('token', async () => expiration(token, issuedAt));
			const profile = await atStage('profile', () => post(c.USERINFO_URL, { client_id: c.client, access_token: token.access_token, scope: c.scope }));
			if (typeof profile.uid !== 'string' || !profile.uid.trim() || profile.uid.length > 256) { throw failure('profile'); }
			const account = await atStage('identity', () => identity(profile));
			if (now() >= expiresAt) { throw failure('expired'); }
			req.session.uniportalAuth = { uid: account.uid, authenticatedAt: issuedAt, expiresAt };
			return account;
		},
	};
}

async function postJSON(url, payload) {
	try {
		const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(10000) });
		if (!response.ok) { throw failure(); }
		const text = await response.text();
		if (text.length > 65536) { throw failure(); }
		const data = JSON.parse(text);
		if (!data || Array.isArray(data) || typeof data !== 'object') { throw failure(); }
		return data;
	} catch { throw failure(); }
}

exports.auth = async function (strategies) {
	if (process.env.UNIPORTAL_ENABLED !== 'true') { return strategies; }
	const c = config();
	const passport = globalThis.nodebb.require('passport');
	const service = createService({ db: globalThis.nodebb.require('./src/database'), user: globalThis.nodebb.require('./src/user') });
	const strategy = new passport.Strategy();
	strategy.name = 'uniportal';
	strategy.authenticate = function (req) {
		(async () => {
			if (req.path === '/auth/uniportal') {
				// Cookies are host-specific. Bind state only on the callback's origin.
				const origin = new URL(c.REDIRECT_URI).origin;
				if (`${req.protocol}://${req.get('host')}` !== origin) {
					return this.redirect(`${origin}/auth/uniportal`);
				}
				if (req.session) { delete req.session.uniportalFailure; }
				this.redirect(await service.begin(req, c));
			} else {
				this.success(await service.complete(req, c));
			}
		// Avoid passing provider errors to NodeBB's error logger, which may log the
		// callback URL (including its authorization code). A failed login redirects.
		})().catch((err) => {
			const stage = Object.hasOwn(failureMessages, err?.uniportalStage) ? err.uniportalStage : 'authentication';
			if (req.session) { req.session.uniportalFailure = stage; }
			globalThis.nodebb.require('winston').warn(`[uniportal] Login failed at stage: ${stage}`);
			this.fail();
		});
	};
	passport.use(strategy);
	strategies.push({ name: 'uniportal', url: '/auth/uniportal', callbackURL: '/auth/uniportal/callback', failureUrl: '/login?local=1&uniportal=failed', checkState: false, icon: 'fa-building', labels: { login: '企业 Uniportal 登录', register: '企业 Uniportal 登录' } });
	return strategies;
};

exports.redirectGuest = async function ({ req, res }) {
	if (process.env.UNIPORTAL_ENABLED !== 'true' || process.env.UNIPORTAL_AUTO_LOGIN !== 'true' ||
		req.method !== 'GET' || req.user?.uid > 0 || req.uid > 0 || req.query.local === '1') { return; }
	// originalUrl survives NodeBB's homepage rewrite to /categories.
	const pathname = new URL(req.originalUrl, 'http://localhost').pathname;
	if (!['/', '/login', '/login/', '/api', '/api/', '/api/login', '/api/login/'].includes(pathname)) { return; }
	const nodebb = globalThis.nodebb;
	// A configuration error must leave the local login page accessible.
	try { config(); } catch { return; }
	nodebb.require('./src/controllers/helpers').redirect(res, { external: '/auth/uniportal' });
};

exports.loginMessage = async function (data) {
	if (data.req.query.uniportal === 'failed') {
		const stage = data.req.session?.uniportalFailure;
		data.templateData.error = Object.hasOwn(failureMessages, stage) ? failureMessages[stage] : failureMessages.authentication;
	}
	return data;
};

exports.displayUsers = async function (users) {
	const nodebb = globalThis.nodebb;
	if (nodebb.require('./src/meta').config.hideFullname) { return users; }
	const candidates = users.filter(u => u && Number(u.uid) > 0 && Object.hasOwn(u, 'displayname'));
	if (!candidates.length) { return users; }
	const db = nodebb.require('./src/database');
	const [profiles, settings] = await Promise.all([
		db.getObjectsFields(candidates.map(u => `user:${u.uid}`), ['uniportalId', 'fullname']),
		db.getObjectsFields(candidates.map(u => `user:${u.uid}:settings`), ['showfullname']),
	]);
	candidates.forEach((u, index) => {
		const profile = profiles[index];
		if (profile?.uniportalId && profile.fullname && Number(settings[index]?.showfullname) === 1) {
			u.displayname = nodebb.require('./src/utils').stripBidiControls(profile.fullname);
		}
	});
	return users;
};

exports.createService = createService;
exports.validateUsername = async function (data) {
	if (data.opts.uniportal && data.user.username !== data.data.username) { throw failure('identity'); }
	return data;
};
exports.config = config;
exports.postJSON = postJSON;

exports.emailConfig = async function (settings) {
	if (Number(settings.uid) > 0 && await globalThis.nodebb.require('./src/database').getObjectField(`user:${settings.uid}`, 'uniportalId')) {
		settings.emailPrompt = 0;
	}
	return settings;
};

let accessControl;
function access() {
	if (!accessControl) {
		const nodebb = globalThis.nodebb;
		accessControl = createAccessControl({ db: nodebb.require('./src/database'), user: nodebb.require('./src/user'), helpers: nodebb.require('./src/controllers/helpers'), sockets: nodebb.require('./src/socket.io'), relativePath: nodebb.require('nconf').get('relative_path') || '' });
	}
	return accessControl;
}

exports.init = async function ({ app }) {
	if (app.uniportalSessionGate) { return; }
	app.uniportalSessionGate = true;
	app.use((req, res, next) => access().http(req, res, next));
};
exports.socketValidate = async data => access().socketValidate(data);
exports.socketConnect = async data => access().socketConnect(data);
