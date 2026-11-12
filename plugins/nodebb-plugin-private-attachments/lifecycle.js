'use strict';

const { randomUUID } = require('node:crypto');
const { attachmentUrl } = require('./attachments');

const recordKey = id => `privateAttachment:${id}`;
const postKey = pid => `privateAttachments:post:${pid}`;
const idsOf = post => JSON.parse(post?.privateAttachmentIds || '[]');
const denied = () => new Error('[[error:no-privileges]]');

function createLifecycle({ db, posts, topics, privileges, meta, getStorage, baseUrl, relativePath = '' }) {
	const origin = new URL(baseUrl).origin;
	const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const attachmentPath = new RegExp(`^${escape(relativePath)}/attachments/([a-f0-9-]{36})/(original|thumbnail)/[^/]+$`);
	let queue = Promise.resolve();
	// 当前部署只有一个工作进程，串行化关联、复制和删除，避免同时认领同一未发布附件。
	function exclusive(task) {
		const result = queue.then(task);
		queue = result.catch(() => {});
		return result;
	}

	function references(text) {
		const result = [];
		for (const match of String(text || '').matchAll(/https?:\/\/[^\s<>"()[\]`]+|\/[^\s<>"()[\]`]+/g)) {
			try {
				const url = new URL(match[0], origin);
				const parsed = url.origin === origin && !url.username && !url.password && url.pathname.match(attachmentPath);
				if (parsed) { result.push({ text: match[0], id: parsed[1], variant: parsed[2] }); }
			} catch (_err) { /* 普通正文里的无效 URL 不应导致发帖失败。 */ }
		}
		return result;
	}

	async function canReadPost(pid, uid) {
		const post = await posts.getPostFields(pid, ['tid', 'deleted']);
		if (!post?.tid) { return false; }
		const [topicReadable, [permission]] = await Promise.all([
			privileges.topics.canRead(post.tid, uid),
			privileges.posts.get([pid], uid),
		]);
		// 同时检查版块 read、topics:read 及已删除回复；单用 posts.canRead 不足以覆盖这些条件。
		return Boolean(topicReadable && permission?.read && permission['topics:read'] && !permission.disabled &&
			(!post.deleted || permission['posts:view_deleted']));
	}

	async function canRead(record, uid) {
		if (!['pending', 'attached'].includes(record.status)) { return false; }
		const post = record.pid && await db.getObject(`post:${record.pid}`);
		if (post && idsOf(post).includes(record.id)) {
			return await canReadPost(record.pid, uid);
		}
		// 关联准备后发帖失败时仍视为未发布，不能因预先写入 pid 就开放访问。
		return uid > 0 && Number(record.uploaderUid) === Number(uid);
	}

	async function copy(record, uid) {
		const { client, bucket } = getStorage();
		const id = randomUUID();
		const sourceVariants = JSON.parse(record.variants);
		const variants = Object.fromEntries(Object.entries(sourceVariants).map(([name, file]) => [
			name, { ...file, objectKey: `${id}/${file.objectKey.split('/').pop()}` },
		]));
		const clone = {
			...record, id, pid: 0, uploaderUid: Number(uid), createdAt: Date.now(), status: 'uploading',
			copiedFrom: record.id, objectKey: variants.original.objectKey, variants: JSON.stringify(variants),
		};
		try {
			await db.setObject(recordKey(id), clone);
			for (const [name, file] of Object.entries(sourceVariants)) {
				await client.copyObject(bucket, variants[name].objectKey, `/${bucket}/${file.objectKey}`);
			}
			clone.status = 'pending';
			await db.setObjectField(recordKey(id), 'status', clone.status);
			return clone;
		} catch (_err) {
			await db.setObjectField(recordKey(id), 'status', 'failed').catch(() => {});
			throw new Error('附件复制失败，请稍后重试');
		}
	}

	async function prepare(pid, uid, fields, oldPost) {
		const texts = [fields.content, fields.sourceContent, ...(fields.thumbs || [])];
		const refs = texts.flatMap(references);
		const records = new Map();
		// 先验证全部引用，再写关联；知道附件 ID 不代表可以转贴附件。
		for (const ref of refs) {
			let record = records.get(ref.id);
			if (!record) {
				record = await db.getObject(recordKey(ref.id));
				if (!record || !await canRead(record, uid)) { throw denied(); }
				records.set(ref.id, record);
			}
			if (!JSON.parse(record.variants)[ref.variant]) { throw denied(); }
		}
		const replacements = new Map();
		for (const [sourceId, source] of records) {
			const record = source.pid && String(source.pid) !== String(pid) ? await copy(source, uid) : source;
			// 历史索引不因正文移除链接而删除，供帖子历史和永久删除使用。
			await db.setAdd(postKey(pid), record.id);
			await db.setObject(recordKey(record.id), { pid: Number(pid), status: 'attached' });
			replacements.set(sourceId, record.id);
		}
		const rewrite = text => {
			let result = text;
			for (const ref of references(text)) {
				result = result.replaceAll(ref.text, ref.text.replace(`/${ref.id}/`, `/${replacements.get(ref.id)}/`));
			}
			return result;
		};
		return {
			content: rewrite(fields.content), sourceContent: rewrite(fields.sourceContent),
			thumbs: (fields.thumbs || []).map(rewrite),
			privateAttachmentIds: JSON.stringify([...new Set([...idsOf(oldPost), ...replacements.values()])]),
		};
	}

	async function preparePost(payload) {
		return await exclusive(async () => {
			const { post, data } = payload;
			const pid = post.pid || data.pid;
			const oldPost = await db.getObject(`post:${pid}`);
			const tid = post.tid || oldPost?.tid;
			const topic = await topics.getTopicFields(tid, ['mainPid', 'thumbs']);
			const isMain = data.isMain || String(topic.mainPid) === String(pid);
			const thumbs = isMain ? (Array.isArray(data.thumbs) ? data.thumbs : topic.thumbs || []) : [];
			const result = await prepare(pid, payload.uid ?? data.uid, { ...post, thumbs }, oldPost);
			Object.assign(post, { content: result.content, sourceContent: result.sourceContent, privateAttachmentIds: result.privateAttachmentIds });
			data.content = result.content;
			data.sourceContent = result.sourceContent;
			if (isMain) {
				data.thumbs = result.thumbs;
				// 新主题的缩略图已先存入 topic；编辑时交给原生 editMainPost 保存。
				if (data.isMain) { await db.setObjectField(`topic:${tid}`, 'thumbs', JSON.stringify(result.thumbs)); }
			}
			return payload;
		});
	}

	async function associateThumb(data) {
		if (!references(data.path).length) { return data; }
		return await exclusive(async () => {
			if (!await privileges.topics.canEdit(data.id, data.uid)) { throw denied(); }
			const pid = await topics.getTopicField(data.id, 'mainPid');
			const post = await db.getObject(`post:${pid}`);
			if (!post) { throw denied(); }
			const result = await prepare(pid, data.uid, { thumbs: [data.path] }, post);
			await db.setObjectField(`post:${pid}`, 'privateAttachmentIds', result.privateAttachmentIds);
			return { ...data, path: result.thumbs[0], isLocal: false };
		});
	}

	async function purge(data) {
		const { pids } = data;
		return await exclusive(async () => {
			for (const pid of pids) {
				const ids = new Set([...await db.getSetMembers(postKey(pid)), ...idsOf(await db.getObject(`post:${pid}`))]);
				for (const id of ids) {
					const record = await db.getObject(recordKey(id));
					if (!record || String(record.pid) !== String(pid)) { continue; }
					try {
						await db.setObjectField(recordKey(id), 'status', 'deleting');
						const { client, bucket } = getStorage();
						for (const file of Object.values(JSON.parse(record.variants))) {
							await client.removeObject(bucket, file.objectKey);
						}
						await db.delete(recordKey(id));
					} catch (_err) {
						// 失败时保留记录和索引，阻止读取；重试永久删除即可继续，无须重新初始化。
						await db.setObjectField(recordKey(id), 'status', 'delete_failed').catch(() => {});
						throw new Error('附件删除失败，请稍后重试永久删除');
					}
				}
				await db.delete(postKey(pid));
			}
			return data;
		});
	}

	async function imageThumbs(pid) {
		const post = await db.getObject(`post:${pid}`);
		const result = [];
		for (const id of new Set(references(post?.content).map(ref => ref.id))) {
			const record = await db.getObject(recordKey(id));
			if (record?.mime?.startsWith('image/') && String(record.pid) === String(pid) && record.status === 'attached') {
				const variant = JSON.parse(record.variants).thumbnail ? 'thumbnail' : 'original';
				const url = attachmentUrl(relativePath, id, variant, record.name);
				result.push({ name: record.name, path: url, url });
			}
		}
		return result;
	}

	async function hasThumbs(data) {
		if (meta.config.showPostUploadsAsThumbnails === 1) {
			await Promise.all(data.topicData.map(async (topic, index) => {
				if (!data.hasThumbs[index] && topic?.mainPid) { data.hasThumbs[index] = (await imageThumbs(topic.mainPid)).length > 0; }
			}));
		}
		return data;
	}

	async function getThumbs(data) {
		for (let index = 0; index < data.tids.length; index += 1) {
			const thumbs = data.thumbs[index];
			thumbs.forEach((thumb) => {
				if (references(thumb.path).length) { thumb.url = thumb.path; }
			});
			if (!data.thumbsOnly && meta.config.showPostUploadsAsThumbnails === 1) {
				const pid = await topics.getTopicField(data.tids[index], 'mainPid');
				for (const thumb of await imageThumbs(pid)) {
					const id = references(thumb.path)[0].id;
					if (!thumbs.some(existing => references(existing.path).some(ref => ref.id === id))) {
						thumbs.push({ id: String(data.tids[index]), ...thumb });
					}
				}
			}
		}
		return data;
	}

	return { preparePost, canRead, canReadPost, associateThumb, purge, hasThumbs, getThumbs };
}

module.exports = { createLifecycle };
