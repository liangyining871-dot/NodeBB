'use strict';

function lifetime(env = process.env) {
	const seconds = Number(env.UNIPORTAL_SESSION_TTL_SECONDS || 1800);
	if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) { throw new Error('Invalid enterprise session lifetime'); }
	return seconds;
}

function expiration(token, issuedAt, env = process.env) {
	let seconds = lifetime(env);
	if (token.expires_in !== undefined) {
		const reported = Number(token.expires_in);
		if (!['string', 'number'].includes(typeof token.expires_in) || !Number.isFinite(reported) || reported <= 0) { throw new Error('Invalid token lifetime'); }
		seconds = Math.min(seconds, reported);
	}
	return issuedAt + (seconds * 1000);
}

function createAccessControl({ db, user, helpers, sockets, env = process.env, now = Date.now, schedule = setTimeout, unschedule = clearTimeout, relativePath = '' }) {
	const active = () => env.UNIPORTAL_ENABLED === 'true' && env.UNIPORTAL_REQUIRE_LOGIN === 'true';
	async function valid(uid, session) {
		if (!(Number(uid) > 0)) { return false; }
		// Local admins/test accounts keep NodeBB's own lifetime. An enterprise account
		// must carry a matching absolute OAuth deadline, including legacy sessions.
		const account = await db.getObjectFields(`user:${uid}`, ['uid', 'uniportalId']);
		if (Number(account?.uid) !== Number(uid)) { return false; }
		if (!account.uniportalId) { return true; }
		const auth = session?.uniportalAuth;
		return Number(auth?.uid) === Number(uid) && Number.isFinite(auth?.expiresAt) && now() < auth.expiresAt;
	}
	async function revoke(sid, uid) {
		if (sid) { await user.auth.revokeSession(sid, Number(uid)); }
		const room = sid && sockets.server?.in(`sess_${sid}`);
		room?.emit('event:invalid_session');
		room?.disconnectSockets(true);
	}
	function pathname(req) {
		const raw = new URL(req.originalUrl || req.url, 'http://localhost').pathname;
		const decoded = require('node:path').posix.normalize(decodeURIComponent(raw));
		return relativePath && (decoded === relativePath || decoded.startsWith(`${relativePath}/`)) ? decoded.slice(relativePath.length) || '/' : decoded;
	}
	function publicRoute(p, method) {
		if (['/auth/uniportal', '/auth/uniportal/callback', '/login', '/api/login', '/logout', '/api/v3/utilities/login'].includes(p)) { return true; }
		if (!['GET', 'HEAD'].includes(method)) { return false; }
		if (p === '/api/config' || p === '/favicon.ico' || p === '/robots.txt' || p === '/manifest.webmanifest') { return true; }
		// User uploads remain protected; only system branding is public.
		return p.startsWith('/assets/') && (!p.startsWith('/assets/uploads/') || p.startsWith('/assets/uploads/system/'));
	}
	async function http(req, res, next) {
		if (!active()) { return next(); }
		try {
			const p = pathname(req);
			// Preserve the browser-bound session throughout the OAuth round trip.
			if (p === '/auth/uniportal' || p === '/auth/uniportal/callback') { return next(); }
			const uid = Number(req.user?.uid || req.uid || 0);
			if (uid > 0 && await valid(uid, req.session)) { return next(); }
			if (uid > 0) {
				await revoke(req.sessionID, uid);
				await new Promise((resolve, reject) => req.logout(err => (err ? reject(err) : resolve())));
				delete req.session.uniportalAuth;
				req.uid = 0;
				req.loggedIn = false;
			}
			if (publicRoute(p, req.method)) { return next(); }
			const loginUrl = `${relativePath}/auth/uniportal`;
			res.set('Cache-Control', 'no-store');
			if (p === '/api' || p.startsWith('/api/') || !['GET', 'HEAD'].includes(req.method)) {
				return res.status(401).json({ status: { code: 'not-authenticated', message: 'Login required or enterprise session expired' }, response: { loginUrl } });
			}
			return helpers.redirect(res, { external: '/auth/uniportal' });
		} catch { return res.status(503).json({ status: { code: 'authentication-unavailable', message: 'Authentication check unavailable' } }); }
	}
	async function socketValidate({ socket, session }) {
		if (!active()) { return; }
		const uid = session?.passport?.user;
		if (Number(socket.uid) === Number(uid) && await valid(uid, session)) { return; }
		socket.emit('event:invalid_session');
		socket.disconnect(true);
		throw new Error('[[error:invalid-session]]');
	}
	async function socketConnect({ socket }) {
		if (!active()) { return; }
		try {
			const session = socket.request.session;
			if (!await valid(socket.uid, session)) { socket.emit('event:invalid_session'); socket.disconnect(true); return; }
			const auth = session?.uniportalAuth;
			if (!auth) { return; }
			const sid = socket.request.signedCookies?.[require('nconf').get('sessionKey')];
			const timer = schedule(() => {
				revoke(sid, socket.uid).catch(() => {}).finally(() => { socket.emit('event:invalid_session'); socket.disconnect(true); });
			}, Math.max(1, auth.expiresAt - now()));
			timer.unref?.();
			socket.once('disconnect', () => unschedule(timer));
		} catch { socket.disconnect(true); }
	}
	return { http, socketValidate, socketConnect, valid };
}

module.exports = { lifetime, expiration, createAccessControl };
