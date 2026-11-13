'use strict';

(() => {
	const root = globalThis;
	const policy = root.config?.uniportalSession;
	if (!policy || Number(policy.uid) !== Number(root.app?.user?.uid)) { return; }
	const loginUrl = `${root.config.relative_path || ''}/auth/uniportal`;
	const remaining = Math.max(0, policy.expiresAt - policy.serverNow);
	const deadline = root.performance.now() + remaining;
	let redirecting = false;
	let boundSocket;

	function preserveDrafts() {
		if (!root.document.querySelector('[component="composer"]')) { return Promise.resolve(); }
		return new Promise((resolve) => {
			root.require(['composer', 'composer/drafts'], (composer, drafts) => {
				try {
					root.$('[component="composer"]').each(function () {
						const container = root.$(this);
						const post = composer.posts[container.attr('data-uuid')];
						if (!post) { return; }
						const saveId = post.save_id || root.utils.generateSaveId(policy.uid);
						const body = container.find('textarea').val();
						const title = container.find('input.title').val() || post.title;
						if (!body && !title) { return; }
						const draft = { save_id: saveId, action: post.action, text: body, title, uuid: container.attr('data-uuid'), timestamp: Date.now(), cid: post.cid, tid: post.tid, pid: post.pid, toPid: post.toPid, tags: container.find('input.tags').val(), thumbs: post.thumbs || [] };
						root.localStorage.setItem(saveId, JSON.stringify(draft));
						drafts.addToDraftList('available', saveId);
						drafts.addToDraftList('open', saveId);
						post.save_id = saveId;
						post.modified = false;
					});
				} catch { /* Preserve native unsaved-content protection if storage is unavailable. */ }
				resolve();
			}, resolve);
		});
	}

	async function redirect() {
		if (redirecting) { return; }
		redirecting = true;
		// A suspended/missing composer module must not leave an expired session
		// stuck indefinitely on the disconnected page.
		try {
			await Promise.race([preserveDrafts(), new Promise(resolve => root.setTimeout(resolve, 2000))]);
		} catch { /* Reauthentication must still work if the draft loader is unavailable. */ }
		root.location.replace(loginUrl);
	}
	function checkDeadline() {
		if (root.performance.now() >= deadline) { redirect(); }
	}
	function bindSocket() {
		if (root.socket && root.socket !== boundSocket) {
			boundSocket = root.socket;
			root.socket.on('event:uniportal.expired', redirect);
			root.socket.on('event:invalid_session', redirect);
			root.socket.on('disconnect', (reason) => {
				if (reason === 'io server disconnect') { redirect(); } else { checkDeadline(); }
			});
		}
	}
	const originalFetch = root.fetch.bind(root);
	root.fetch = async (...args) => {
		const response = await originalFetch(...args);
		if (response.status === 401 && response.headers.get('X-Uniportal-Login') === loginUrl) { redirect(); }
		return response;
	};
	root.$(root.document).on('ajaxError.uniportal', (event, xhr) => {
		if (xhr.status === 401 && xhr.getResponseHeader('X-Uniportal-Login') === loginUrl) { redirect(); }
	});
	root.document.addEventListener('visibilitychange', checkDeadline);
	root.addEventListener('focus', checkDeadline);
	root.setTimeout(redirect, remaining);
	bindSocket();
	root.app.require('hooks').then((hooks) => {
		hooks.on('action:connected', bindSocket);
		hooks.on('action:app.load', bindSocket);
		hooks.on('action:ajaxify.end', checkDeadline);
	});
})();
