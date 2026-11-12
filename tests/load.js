'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const cookieFetch = require('fetch-cookie').default;
const { setTimeout: pause } = require('node:timers/promises');
const { CookieJar } = require('tough-cookie');
const { Agent, fetch: transportFetch } = require('undici');

async function main() {
	const config = JSON.parse(await fs.readFile(process.argv[2] || path.join(__dirname, 'load.example.json'), 'utf8'));
	const base = new URL(config.baseUrl);
	if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') { throw new Error('baseUrl must be a plain HTTP(S) origin.'); }
	for (const [key, min, max] of [['users', 1, 500], ['durationSeconds', 1, 600], ['thinkTimeMs', 100, 60000], ['timeoutMs', 100, 30000]]) {
		if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) { throw new Error(`Invalid configuration: ${key}`); }
	}
	if (!Array.isArray(config.endpoints) || !config.endpoints.length || config.endpoints.some(e =>
		!/^\/api\/(?:categories|recent|category\/[0-9]+(?:\/[^?#]*)?|topic\/[0-9]+(?:\/[^?#]*)?)$/.test(e.path) || !['categories', 'topics', 'posts'].includes(e.arrayField))) {
		throw new Error('Only category, recent and topic read APIs are supported.');
	}
	const accounts = config.accountsFile ? JSON.parse(await fs.readFile(path.resolve(path.dirname(process.argv[2]), config.accountsFile), 'utf8')) : null;
	if (accounts && (!Array.isArray(accounts) || accounts.length < config.users || accounts.some(a => !a.username || !a.password) || new Set(accounts.map(a => a.username)).size !== accounts.length)) {
		throw new Error('Provide a distinct, existing local test account for each virtual user.');
	}
	const clients = [];
	const dispatchers = [];
	const sessionsFile = path.join(__dirname, 'sessions.local.json');
	let sessions = {};
	try { sessions = JSON.parse(await fs.readFile(sessionsFile, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') { throw err; } }
	async function jsonRequest(client, route, options = {}) {
		const response = await client(new URL(route, base), { ...options, redirect: 'manual', signal: AbortSignal.timeout(config.timeoutMs) });
		if (response.status !== 200 || !response.headers.get('content-type')?.includes('application/json')) {
			await response.body?.cancel();
			throw new Error(`HTTP ${response.status}`);
		}
		return response.json();
	}
	console.log(`Preparing ${config.users} ${accounts ? 'local-account' : 'guest'} clients. OAuth services will not be requested.`);
	for (let i = 0; i < config.users; i += 1) {
		const saved = accounts && sessions[accounts[i].username];
		const jar = saved?.origin === base.origin && saved?.uid === Number(accounts[i]?.uid) ? CookieJar.deserializeSync(saved.jar) : new CookieJar();
		const dispatcher = ['127.0.0.1', 'localhost'].includes(base.hostname) && i < 250 ? new Agent({ localAddress: `127.0.0.${i + 2}` }) : new Agent();
		dispatchers.push(dispatcher);
		const client = cookieFetch((url, options) => transportFetch(url, { ...options, dispatcher }), jar);
		if (accounts) {
			const initial = await jsonRequest(client, '/api/config');
			if (!(initial.loggedIn && Number(initial.uid) === Number(accounts[i].uid))) { await jsonRequest(client, '/login', {
				method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': initial.csrf_token },
				body: JSON.stringify({ username: accounts[i].username, password: accounts[i].password }),
			}); }
			const authenticated = await jsonRequest(client, '/api/config');
			if (!(authenticated.uid > 0 && authenticated.loggedIn && (!accounts[i].uid || Number(authenticated.uid) === Number(accounts[i].uid)))) { throw new Error('Test account login did not complete. Check registration consent, account status and local login permissions.'); }
			sessions[accounts[i].username] = { origin: base.origin, uid: Number(authenticated.uid), jar: jar.serializeSync() };
			await fs.writeFile(sessionsFile, JSON.stringify(sessions), { mode: 0o600 });
			await pause(300);
		}
		clients.push(client);
	}
	// Fail before applying load if an endpoint returns a login page or a wrong payload.
	for (const endpoint of config.endpoints) {
		const data = await jsonRequest(clients[0], endpoint.path);
		if (!Array.isArray(data[endpoint.arrayField])) { throw new Error('Endpoint preflight failed: expected forum data, not a login or registration response.'); }
	}
	const metrics = config.endpoints.map(e => ({ path: e.path, requests: 0, failures: 0, errors: {}, histogram: new Uint32Array(config.timeoutMs + 2) }));
	const start = performance.now();
	console.log(`Browse traffic started: ${config.users} users, ${config.durationSeconds} seconds, ${config.thinkTimeMs} ms think time.`);
	const deadline = start + (config.durationSeconds * 1000);
	await Promise.all(clients.map(async (client, index) => {
		let iteration = index;
		while (performance.now() < deadline) {
			const slot = iteration % metrics.length;
			const metric = metrics[slot];
			const before = performance.now();
			metric.requests += 1;
			try {
				const data = await jsonRequest(client, config.endpoints[slot].path);
				if (!Array.isArray(data[config.endpoints[slot].arrayField])) { throw new Error('Unexpected payload'); }
			} catch (err) {
				metric.failures += 1;
				// Store status categories only; never persist response bodies or credentials.
				const reason = /^HTTP \d+$/.test(err.message) ? err.message : 'network-timeout-or-invalid-payload';
				metric.errors[reason] = (metric.errors[reason] || 0) + 1;
			}
			metric.histogram[Math.min(config.timeoutMs + 1, Math.ceil(performance.now() - before))] += 1;
			iteration += 1;
			await pause(Math.min(config.thinkTimeMs, Math.max(0, deadline - performance.now())));
		}
	}));
	const elapsedSeconds = (performance.now() - start) / 1000;
	function percentile(metric, fraction) {
		if (!metric.requests) { return null; }
		let seen = 0;
		for (let i = 0; i < metric.histogram.length; i += 1) {
			seen += metric.histogram[i];
			if (seen >= Math.ceil(metric.requests * fraction)) { return i; }
		}
		return null;
	}
	const report = {
		at: new Date().toISOString(), baseUrl: base.origin, mode: accounts ? 'local-accounts' : 'guests', users: config.users,
		elapsedSeconds, thinkTimeMs: config.thinkTimeMs,
		endpoints: metrics.map(m => ({ path: m.path, requests: m.requests, failures: m.failures, errorRate: m.requests ? m.failures / m.requests : 0, requestsPerSecond: m.requests / elapsedSeconds, p50Ms: percentile(m, 0.5), p95Ms: percentile(m, 0.95), p99Ms: percentile(m, 0.99), errors: m.errors })),
	};
	const directory = path.join(__dirname, 'results');
	await fs.mkdir(directory, { recursive: true });
	const output = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
	await fs.writeFile(output, JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
	console.log(`Report: ${output}`);
	await Promise.all(dispatchers.map(dispatcher => dispatcher.close()));
	if (metrics.some(m => m.failures)) { process.exitCode = 1; }
}

main().catch(() => {
	console.error('Load test stopped. Check configuration, endpoint access and local test-account login. No credentials or response bodies printed.');
	process.exitCode = 1;
});
