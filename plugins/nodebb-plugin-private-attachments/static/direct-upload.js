'use strict';

define('private-attachments/direct-upload', [], function () {
	const isVideo = file => /\.(mp4|wmv|webm|ogg)$/i.test(file.name || '');
	const aborted = () => new DOMException('上传已取消', 'AbortError');
	const delay = (ms, signal) => new Promise((resolve, reject) => {
		if (signal.aborted) { reject(aborted()); return; }
		const stop = () => { clearTimeout(timer); reject(aborted()); };
		const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
		signal.addEventListener('abort', stop, { once: true });
	});

	async function request(base, route, body, signal) {
		const response = await fetch(`${base}${route}`, { method: 'POST', credentials: 'same-origin', signal,
			headers: { 'Content-Type': 'application/json', 'x-csrf-token': config.csrf_token }, body: JSON.stringify(body) });
		let payload;
		try { payload = await response.json(); } catch (_err) { throw new Error('上传认证已失效或服务暂不可用，请重新登录后重试'); }
		if (!response.ok) { throw Object.assign(new Error(payload.error || '上传失败'), { status: response.status }); }
		return payload;
	}

	function put(url, blob, signal, progress) {
		return new Promise((resolve, reject) => {
			if (signal.aborted) { reject(aborted()); return; }
			const xhr = new XMLHttpRequest();
			const stop = () => xhr.abort();
			function finish(callback, value) { signal.removeEventListener('abort', stop); callback(value); }
			xhr.open('PUT', url);
			xhr.timeout = 5 * 60 * 1000;
			xhr.upload.onprogress = event => progress(event.loaded);
			xhr.onload = () => {
				if (xhr.status >= 200 && xhr.status < 300) { finish(resolve); } else {
					finish(reject, Object.assign(new Error('视频分片上传失败'), { status: xhr.status }));
				}
			};
			xhr.onerror = () => finish(reject, new Error('无法连接上传服务，请检查网络或联系管理员'));
			xhr.ontimeout = () => finish(reject, new Error('分片上传超时'));
			xhr.onabort = () => finish(reject, aborted());
			signal.addEventListener('abort', stop, { once: true });
			xhr.send(blob);
		});
	}

	async function uploadFile(file, { signal, onProgress = () => {}, onState = () => {}, retryDelay = 1000 } = {}) {
		signal = signal || new AbortController().signal;
		const base = `${config.relative_path || ''}/api/private-attachments/uploads`;
		const task = await request(base, '', { name: file.name, size: file.size }, signal);
		const loaded = Array(task.partCount).fill(0);
		let next = 0;
		let failure;
		const workers = new AbortController();
		const stop = () => workers.abort();
		signal.addEventListener('abort', stop, { once: true });
		if (signal.aborted) { workers.abort(); }
		const update = () => onProgress(loaded.reduce((sum, value) => sum + value, 0), file.size);
		async function retry(callback, part) {
			for (let attempt = 0; ; attempt += 1) {
				try { return await callback(); } catch (err) {
					if (workers.signal.aborted || err.name === 'AbortError') { throw aborted(); }
					if (attempt >= 3 || [400, 404, 409, 410, 413, 429].includes(err.status)) { throw err; }
					onState(`网络波动，正在重试${part ? `第 ${part} 个分片` : '确认上传'}…`);
					await delay(retryDelay * (2 ** attempt), workers.signal);
				}
			}
		}
		try {
			async function worker() {
				while (next < task.partCount && !workers.signal.aborted) {
					const index = next++;
					const blob = file.slice(index * task.partSize, Math.min(file.size, (index + 1) * task.partSize));
					await retry(async () => {
						loaded[index] = 0;
						update();
						// 每次重试都重新取签名，长时间上传不受旧签名过期影响。
						const signed = await request(base, `/${task.id}/part`, { partNumber: index + 1 }, workers.signal);
						await put(signed.url, blob, workers.signal, bytes => { loaded[index] = bytes; update(); });
					}, index + 1);
					loaded[index] = blob.size;
					update();
				}
			}
			const jobs = Array.from({ length: Math.min(task.concurrency || 3, task.partCount) }, () => worker().catch(err => {
				failure = failure || err;
				workers.abort();
			}));
			await Promise.all(jobs);
			if (failure) { throw failure; }
			if (workers.signal.aborted) { throw aborted(); }
			onState('视频已传输，正在确认文件…');
			return await retry(() => request(base, `/${task.id}/complete`, {}, workers.signal));
		} catch (err) {
			workers.abort();
			// 取消请求使用独立 signal；页面直接关闭时由服务端过期任务清理兜底。
			await request(base, `/${task.id}/cancel`, {}, AbortSignal.timeout(10000)).catch(() => {});
			throw err;
		} finally { signal.removeEventListener('abort', stop); }
	}

	function normalFile(file, route, cid, signal) {
		const form = new FormData();
		form.append('files[]', file, file.name);
		form.append('cid', cid || '');
		return fetch(route, { method: 'POST', credentials: 'same-origin', signal,
			headers: { 'x-csrf-token': config.csrf_token }, body: form }).then(async response => {
			const data = await response.json();
			if (!response.ok) { throw new Error(data.error || data.status?.message || '上传失败'); }
			return data.response.images[0];
		});
	}
	return { isVideo, uploadFile, normalFile };
});
