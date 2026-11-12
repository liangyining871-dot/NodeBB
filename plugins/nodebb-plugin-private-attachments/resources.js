'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');

const hash = value => createHash('sha256').update(value).digest('hex');
const aliasKey = name => `privateResourcePath:${hash(name)}`;
const recordKey = id => `privateResource:${id}`;
const directoryKey = name => `privateResourceDir:${hash(name)}`;
const folderKey = name => `privateResourceFolder:${hash(name)}`;
const ownerKey = record => `privateResourceOwner:${record.scope}:${hash(String(record.owner || ''))}`;
const roots = ['category', 'emoji', 'files', 'profile', 'sounds', 'system'];

function createResources({ db, privileges, user, groups, categories, getStorage, uploadPath, baseUrl,
	relativePath = '', detectFile, detectBuffer, dimensions, sanitizeSvg }) {
	const prefix = `${relativePath}/assets/uploads/`;
	const origin = new URL(baseUrl).origin;
	let queue = Promise.resolve();
	function exclusive(task) {
		const result = queue.then(task);
		queue = result.catch(() => {});
		return result;
	}

	function logicalPath(value) {
		if (typeof value !== 'string') { return null; }
		if (/^https?:\/\//i.test(value)) {
			const url = new URL(value);
			if (url.origin !== origin) { return null; }
			value = url.pathname;
		}
		if (value.startsWith(prefix)) {
			value = decodeURIComponent(value.slice(prefix.length));
		} else if (value.startsWith('/assets/uploads/')) {
			value = decodeURIComponent(value.slice('/assets/uploads/'.length));
		} else if (path.isAbsolute(value)) {
			const relative = path.relative(uploadPath, value);
			if (relative.startsWith('..') || path.isAbsolute(relative)) { return null; }
			value = relative;
		} else { return null; }
		value = value.replace(/\\/g, '/');
		if (value.split('/').some(part => part === '..' || part === '.') || /[\x00-\x1f\x7f:]/.test(value)) { throw new Error('[[error:invalid-path]]'); }
		return value.replace(/^\/+|\/+$/g, '');
	}

	const urlFor = name => `/assets/uploads/${name.split('/').map(encodeURIComponent).join('/')}`;
	async function recordFor(name) {
		const alias = await db.getObject(aliasKey(name));
		return alias && await db.getObject(recordKey(alias.id));
	}
	async function mkdir(name) {
		const parts = name.split('/').filter(Boolean);
		for (let index = 0; index < parts.length; index += 1) {
			await db.setAdd(directoryKey(parts.slice(0, index).join('/')), `${parts[index]}/`);
			await db.setObject(folderKey(parts.slice(0, index + 1).join('/')), { createdAt: Date.now() });
		}
	}
	function classify(name) {
		const profile = name.match(/^profile\/uid-(\d+)\//);
		if (profile) { return { scope: 'user', owner: Number(profile[1]), type: name.includes('profilecover') ? 'profile-cover' : 'avatar' }; }
		const category = name.match(/^category\/category-(\d+)/);
		if (category) { return { scope: 'category', owner: Number(category[1]), type: name.includes('-icon.') ? 'category-icon' : 'category-picture' }; }
		if (/^(system|emoji|sounds)\//.test(name)) { return { scope: 'site', type: name.split('/')[0] }; }
		return { scope: 'admin', type: 'admin-file' };
	}
	async function retire(record) {
		await db.setObjectField(recordKey(record.id), 'status', 'deleting');
		const { client, bucket } = await getStorage();
		await client.removeObject(bucket, record.objectKey);
		await db.delete(recordKey(record.id));
	}
	async function save(name, data) {
		if (!name) { throw new Error('[[error:invalid-path]]'); }
		const id = randomUUID();
		if (data.unique && await recordFor(name)) {
			const ext = path.posix.extname(name);
			name = `${name.slice(0, name.length - ext.length)}-${id.slice(0, 8)}${ext}`;
		}
		let buffer = data.buffer;
		const isSvg = path.posix.extname(name).toLowerCase() === '.svg';
		// 所有 SVG，包括生成图标和表情，都使用同一清洗规则，才能安全地内联显示。
		if (isSvg) {
			buffer = Buffer.from(sanitizeSvg((buffer || await fs.readFile(data.tempPath)).toString('utf8')));
		}
		const detected = buffer ? await detectBuffer(buffer) : await detectFile(data.tempPath);
		const mime = isSvg ? 'image/svg+xml' : detected?.mime || 'application/octet-stream';
		const size = buffer ? buffer.length : (await fs.stat(data.tempPath)).size;
		let imageSize = {};
		if (mime.startsWith('image/') && mime !== 'image/x-icon' && mime !== 'image/vnd.microsoft.icon') {
			imageSize = await dimensions(buffer || data.tempPath);
		}
		const extension = isSvg ? 'svg' : detected?.ext || path.posix.extname(name).slice(1).toLowerCase();
		const suffix = /^[a-z0-9]{1,16}$/.test(extension) ? `.${extension}` : '';
		const record = { id, name: path.posix.basename(name), logicalPath: name, objectKey: `${id}/original${suffix}`,
			mime, size, ...imageSize, ...classify(name), ...data.resource, createdAt: Date.now(), status: 'uploading' };
		const previous = await recordFor(name);
		await db.setObject(recordKey(id), record);
		const { client, bucket } = await getStorage();
		try {
			if (buffer) {
				await client.putObject(bucket, record.objectKey, buffer, size, { 'Content-Type': mime });
			} else {
				await client.fPutObject(bucket, record.objectKey, data.tempPath, { 'Content-Type': mime });
			}
			await mkdir(path.posix.dirname(name) === '.' ? '' : path.posix.dirname(name));
			await db.setAdd(directoryKey(path.posix.dirname(name) === '.' ? '' : path.posix.dirname(name)), path.posix.basename(name));
			await db.setAdd(ownerKey(record), name);
			await db.setObjectField(recordKey(id), 'status', 'ready');
			// 新对象就绪后才切换稳定地址，防止替换上传失败导致原资源丢失。
			await db.setObject(aliasKey(name), { id });
		} catch (_err) {
			await db.setObjectField(recordKey(id), 'status', 'failed').catch(() => {});
			throw new Error('资源保存失败，请稍后重试');
		}
		if (previous) {
			await retire(previous).catch(async () => {
				await db.setObjectField(recordKey(previous.id), 'status', 'delete_failed').catch(() => {});
			});
			if (ownerKey(previous) !== ownerKey(record)) { await db.setRemove(ownerKey(previous), name); }
		}
		return { url: urlFor(name), path: path.join(uploadPath, name), name: record.name };
	}

	async function stat(name) {
		const record = await recordFor(name);
		if (record?.status === 'ready') { return { ...record, isDirectory: false }; }
		const entries = await db.getSetMembers(directoryKey(name));
		if (!name || roots.includes(name) || entries.length || await db.getObject(folderKey(name))) { return { isDirectory: true, size: 0 }; }
		return null;
	}
	async function remove(name) {
		const record = await recordFor(name);
		if (!record) {
			if (await db.getObject(folderKey(name))) {
				if ((await db.getSetMembers(directoryKey(name))).length) { throw new Error('目录非空'); }
				await db.delete(folderKey(name));
				await db.delete(directoryKey(name));
				await db.setRemove(directoryKey(path.posix.dirname(name) === '.' ? '' : path.posix.dirname(name)), `${path.posix.basename(name)}/`);
			}
			return;
		}
		await retire(record);
		await db.delete(aliasKey(name));
		await db.setRemove(directoryKey(path.posix.dirname(name) === '.' ? '' : path.posix.dirname(name)), path.posix.basename(name));
		await db.setRemove(ownerKey(record), name);
	}
	async function list(name) {
		const names = await db.getSetMembers(directoryKey(name));
		if (!name) { roots.forEach(root => { if (!names.includes(`${root}/`)) { names.push(`${root}/`); } }); }
		return await Promise.all(names.sort().map(async (entry) => {
			const isDirectory = entry.endsWith('/');
			const cleanName = entry.replace(/\/$/, '');
			const logical = [name, cleanName].filter(Boolean).join('/');
			const record = isDirectory ? null : await recordFor(logical);
			return { name: cleanName, path: logical, url: urlFor(logical), isDirectory, isFile: !isDirectory,
				size: record?.size || 0, sizeHumanReadable: `${((record?.size || 0) / 1024).toFixed(1)}KiB`,
				mtime: record?.createdAt || 0, fileCount: isDirectory ? (await db.getSetMembers(directoryKey(logical))).length : 0 };
		}));
	}
	async function storage(data) {
		const name = logicalPath(data.path);
		if (name === null) { return data; }
		try {
			let result;
			switch (data.operation) {
				case 'target': break;
				case 'save': result = await exclusive(() => save(name, data)); break;
				case 'stat': result = await stat(name); break;
				case 'delete': await exclusive(() => remove(name)); break;
				case 'mkdir': await exclusive(() => mkdir(name)); break;
				case 'list': result = await list(name); break;
				case 'export': {
					const { client, bucket } = await getStorage();
					async function append(folder) {
						for (const entry of await list(folder)) {
							if (entry.isDirectory) { await append(entry.path); continue; }
							const record = await recordFor(entry.path);
							if (record?.status === 'ready') {
								data.archive.append(await client.getObject(bucket, record.objectKey), { name: `profile/${path.posix.relative(name, entry.path)}` });
							}
						}
					}
					await append(name);
					break;
				}
				case 'read': {
					const record = await recordFor(name);
					if (record?.status !== 'ready') { throw new Error('资源不存在'); }
					const { client, bucket } = await getStorage();
					const stream = await client.getObject(bucket, record.objectKey);
					const chunks = [];
					for await (const chunk of stream) { chunks.push(Buffer.from(chunk)); }
					result = Buffer.concat(chunks);
					break;
				}
				default: return data;
			}
			return { ...data, handled: true, result };
		} catch (_err) { throw new Error('MinIO 资源操作失败，请检查存储连接和权限'); }
	}

	async function canRead(record, uid) {
		if (record.status !== 'ready') { return false; }
		if (record.scope === 'site') { return true; }
		if (record.scope === 'user') {
			return await user.exists(record.owner) && (Number(record.owner) === uid || await privileges.global.can('view:users', uid));
		}
		if (record.scope === 'category') {
			if (!await categories.exists(record.owner) || await categories.getCategoryField(record.owner, 'disabled')) { return false; }
			return await privileges.categories.can('read', record.owner, uid);
		}
		if (record.scope === 'group') {
			if (!await groups.exists(record.owner) || !await privileges.global.can('view:groups', uid)) { return false; }
			return !await groups.isHidden(record.owner) || await privileges.admin.can('admin:groups', uid) ||
				await user.isGlobalModerator(uid) || await groups.isMember(uid, record.owner) || await groups.isInvited(uid, record.owner);
		}
		return await user.isAdministrator(uid);
	}
	async function getReadable(name, uid) {
		const record = await recordFor(name);
		if (!record || !await canRead(record, uid)) { throw Object.assign(new Error('资源不存在或无权访问'), { status: 404 }); }
		return { record, file: record };
	}
	async function deleteOwner(scope, owner) {
		await exclusive(async () => {
			const key = ownerKey({ scope, owner });
			for (const name of await db.getSetMembers(key)) {
				const record = await recordFor(name);
				if (record?.scope === scope && String(record.owner) === String(owner)) { await remove(name); }
			}
			await db.delete(key);
		});
	}
	async function renameOwner(scope, oldOwner, newOwner) {
		await exclusive(async () => {
			const key = ownerKey({ scope, owner: oldOwner });
			for (const name of await db.getSetMembers(key)) {
				const record = await recordFor(name);
				if (record?.scope === scope && String(record.owner) === String(oldOwner)) {
					await db.setObjectField(recordKey(record.id), 'owner', newOwner);
					await db.setAdd(ownerKey({ scope, owner: newOwner }), name);
				}
			}
			await db.delete(key);
		});
	}
	return { storage, getReadable, logicalPath, deleteOwner, renameOwner };
}

module.exports = { createResources };
