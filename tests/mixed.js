'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { setTimeout: pause } = require('node:timers/promises');
const cookieFetch = require('fetch-cookie').default;
const { CookieJar } = require('tough-cookie');
const { Agent, fetch: transportFetch } = require('undici');
let stage = 'configuration';

async function main() {
	const configPath = process.argv[2] || path.join(__dirname, 'mixed.local.json');
	const c = JSON.parse(await fs.readFile(configPath, 'utf8'));
	const base = new URL(c.baseUrl);
	if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash ||
		!Number.isInteger(c.cid) || c.cid < 1 || !Number.isInteger(c.users) || c.users < 1 || c.users > 100 ||
		!Number.isInteger(c.durationSeconds) || c.durationSeconds < 1 || c.durationSeconds > 180 || c.thinkTimeMs < 500 ||
		c.maxTopics !== 5 || c.maxReplies !== 15 || c.maxVotes !== 25) { throw new Error('Invalid configuration'); }
	const accounts = JSON.parse(await fs.readFile(path.resolve(path.dirname(configPath), c.accountsFile), 'utf8'));
	if (accounts.length < c.users || accounts.slice(0, c.users).some(a => !/^test\d+$/.test(a.username) || !a.password || !a.uid)) { throw new Error('Unexpected test accounts'); }
	const runId = new Date().toISOString().replace(/[:.]/g, '-');
	const topics = [];
	const replies = [];
	const votes = [];
	const metrics = {};
	let serverErrors = 0;
	let stop = false;
	async function request(client, route, options = {}) {
		const response = await client(new URL(route, base), { ...options, redirect: 'manual', signal: AbortSignal.timeout(10000) });
		if (!response.headers.get('content-type')?.includes('application/json')) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
		const data = await response.json();
		if (![200, 202].includes(response.status)) {
			const error = new Error(`HTTP ${response.status}`);
			const raw = String(data.status?.message || '');
			error.kind = raw.match(/\[\[error:([a-z0-9:-]+)/)?.[1] || (/csrf/i.test(raw) ? 'csrf' : /privilege/i.test(raw) ? 'privilege' : error.message);
			throw error;
		}
		return { data, status: response.status };
	}
	const clients = [];
	const sessionsFile = path.join(__dirname, 'sessions.local.json');
	let sessions = {};
	try { sessions = JSON.parse(await fs.readFile(sessionsFile, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') { throw err; } }
	console.log(`Preparing ${c.users} local test sessions; limited writes in category ${c.cid}.`);
	for (let i = 0; i < c.users; i += 1) {
		stage = `login preparation for test account ${i + 1}`;
		const source = ['127.0.0.1', 'localhost'].includes(base.hostname) ? `127.0.0.${i + 2}` : null;
		const dispatcher = source ? new Agent({ localAddress: source }) : null;
		const saved = sessions[accounts[i].username];
		const jar = saved?.origin === base.origin && saved?.uid === Number(accounts[i].uid) ? CookieJar.deserializeSync(saved.jar) : new CookieJar();
		const client = cookieFetch((url, options) => transportFetch(url, { ...options, ...(dispatcher ? { dispatcher } : {}) }), jar);
		stage = `initial config for test account ${i + 1}`;
		const initial = (await request(client, '/api/config')).data;
		if (!(initial.loggedIn && Number(initial.uid) === Number(accounts[i].uid))) {
			stage = `password login for test account ${i + 1}`;
			await request(client, '/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': initial.csrf_token }, body: JSON.stringify({ username: accounts[i].username, password: accounts[i].password }) });
		}
		stage = `session verification for test account ${i + 1}`;
		const authenticated = (await request(client, '/api/config')).data;
		if (!authenticated.loggedIn || Number(authenticated.uid) !== Number(accounts[i].uid)) { throw new Error('Wrong session identity'); }
		sessions[accounts[i].username] = { origin: base.origin, uid: Number(authenticated.uid), jar: jar.serializeSync() };
		await fs.writeFile(sessionsFile, JSON.stringify(sessions), { mode: 0o600 });
		clients.push({ fetch: client, csrf: authenticated.csrf_token, uid: Number(authenticated.uid), dispatcher });
		await pause(300);
	}
	stage = 'test category access';
	const category = (await request(clients[0].fetch, `/api/category/${c.cid}`)).data;
	if (Number(category.cid) !== c.cid || !category.name?.startsWith('Load Test -')) { throw new Error('Not a test category'); }
	async function operation(name, action) {
		const metric = metrics[name] ||= { attempts: 0, published: 0, queued: 0, failures: 0, errors: {}, durations: [] };
		metric.attempts += 1;
		const before = performance.now();
		try {
			const queued = await action();
			metric[queued ? 'queued' : 'published'] += 1;
		} catch (err) {
			metric.failures += 1;
			const kind = err.kind || (/^HTTP \d+$/.test(err.message) ? err.message : 'network-timeout-or-invalid-payload');
			metric.errors[kind] = (metric.errors[kind] || 0) + 1;
			if (/HTTP 5|network/.test(kind)) { serverErrors += 1; }
			if (serverErrors >= 10) { stop = true; }
		} finally { metric.durations.push(performance.now() - before); }
	}
	function write(client, route, body, method = 'POST') {
		return request(client.fetch, route, { method, headers: { 'Content-Type': 'application/json', 'x-csrf-token': client.csrf }, body: JSON.stringify(body) });
	}
	const start = performance.now();
	stage = 'mixed traffic';
	const deadline = start + (c.durationSeconds * 1000);
	await Promise.all(clients.map(async (client, index) => {
		let iteration = index;
		let topicAttempted = false;
		let replyAttempted = false;
		let voteAttempted = false;
		while (!stop && performance.now() < deadline) {
			const elapsed = (performance.now() - start) / 1000;
			if (index < c.maxTopics && !topicAttempted && elapsed >= 3 + (index * 2)) {
				topicAttempted = true;
				await operation('create-topic', async () => {
					const result = await write(client, '/api/v3/topics', { cid: c.cid, title: `[LOADTEST ${runId}] Topic ${index + 1}`, content: `[LOADTEST ${runId}] Automated bounded mixed-load test. Account ${index + 1}. This content is test data only.` });
					if (result.status === 202 || result.data.response?.queued) { return true; }
					const topic = result.data.response;
					if (!topic?.tid || !topic.mainPid || Number(topic.cid) !== c.cid) { throw new Error('Invalid topic result'); }
					topics.push({ tid: Number(topic.tid), pid: Number(topic.mainPid), uid: client.uid });
					return false;
				});
			} else if (index >= 5 && index < 5 + c.maxReplies && !replyAttempted && topics.length && elapsed >= 20 + ((index - 5) * 1.2)) {
				replyAttempted = true;
				await operation('reply', async () => {
					const target = topics[index % topics.length];
					const result = await write(client, `/api/v3/topics/${target.tid}`, { content: `[LOADTEST ${runId}] Automated test reply by account ${index + 1}.` });
					if (result.status === 202 || result.data.response?.queued) { return true; }
					const post = result.data.response;
					if (!post?.pid || Number(post.tid) !== target.tid) { throw new Error('Invalid reply result'); }
					replies.push({ tid: target.tid, pid: Number(post.pid), uid: client.uid });
					return false;
				});
			} else if (index < c.maxVotes && !voteAttempted && topics.some(t => t.uid !== client.uid) && elapsed >= 50 + (index * 0.4)) {
				voteAttempted = true;
				await operation('upvote', async () => {
					const target = topics.filter(t => t.uid !== client.uid)[index % topics.filter(t => t.uid !== client.uid).length];
					const result = await write(client, `/api/v3/posts/${target.pid}/vote`, { delta: 1 }, 'PUT');
					if (result.data.status?.code !== 'ok') { throw new Error('Invalid vote result'); }
					votes.push({ pid: target.pid, uid: client.uid });
					return false;
				});
			} else {
				const slot = iteration % (topics.length ? 3 : 2);
				const route = slot === 0 ? '/api/recent' : slot === 1 ? `/api/category/${c.cid}` : `/api/topic/${topics[index % topics.length].tid}`;
				const field = slot === 0 || slot === 1 ? 'topics' : 'posts';
				await operation(slot === 0 ? 'browse-recent' : slot === 1 ? 'browse-category' : 'browse-topic', async () => {
					const result = await request(client.fetch, route);
					if (!Array.isArray(result.data[field])) { throw new Error('Invalid read result'); }
					return false;
				});
			}
			iteration += 1;
			await pause(Math.min(c.thinkTimeMs, Math.max(0, deadline - performance.now())));
		}
	}));
	const elapsedSeconds = (performance.now() - start) / 1000;
	const report = { runId, baseUrl: base.origin, users: c.users, cid: c.cid, elapsedSeconds, stoppedEarly: stop, limits: { topics: c.maxTopics, replies: c.maxReplies, votes: c.maxVotes }, operations: {}, created: { topics, replies, votes } };
	for (const [name, m] of Object.entries(metrics)) {
		m.durations.sort((a, b) => a - b);
		const percentile = fraction => Math.ceil(m.durations[Math.ceil(m.durations.length * fraction) - 1]);
		report.operations[name] = { attempts: m.attempts, successful: m.published, queued: m.queued, failures: m.failures, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), errors: m.errors };
	}
	await fs.mkdir(path.join(__dirname, 'results'), { recursive: true });
	const output = path.join(__dirname, 'results', `mixed-${runId}.json`);
	await fs.writeFile(output, JSON.stringify(report, null, 2));
	console.log(JSON.stringify({ ...report, created: { topics: topics.length, replies: replies.length, votes: votes.length } }, null, 2));
	console.log(`Report: ${output}`);
	await Promise.all(clients.map(client => client.dispatcher?.close()));
	if (stop || Object.values(metrics).some(m => m.failures || m.queued)) { process.exitCode = 1; }
}

main().catch((err) => {
	console.error(`Mixed load stopped at ${stage}; ${/^HTTP \d+$/.test(err.message) ? err.message : 'configuration-or-response-check-failed'} (${err.kind || 'unknown'}). No credentials or server response bodies printed.`);
	process.exitCode = 1;
});
