'use strict';

const { connect } = require('./storage');
const { createAttachments } = require('./attachments');
const { createReadHandler } = require('./routes');
const { createLifecycle } = require('./lifecycle');
const { createResources } = require('./resources');
const { registerResourceRoutes } = require('./resource-routes');

let storage;
let attachments;
let lifecycle;
let resources;
let connection;

async function ensureStorage() {
	if (storage) { return storage; }
	connection = connection || connect().then((result) => { storage = result; return result; }).catch((err) => { connection = undefined; throw err; });
	return await connection;
}

function getResources() {
	if (!resources) {
		const requireNodeBB = global.nodebb.require;
		const nconf = requireNodeBB('nconf');
		const sharp = requireNodeBB('sharp');
		resources = createResources({
			db: requireNodeBB('./src/database'), user: requireNodeBB('./src/user'), groups: requireNodeBB('./src/groups'),
			categories: requireNodeBB('./src/categories'), privileges: requireNodeBB('./src/privileges'),
			getStorage: ensureStorage, uploadPath: nconf.get('upload_path'), baseUrl: nconf.get('url'),
			relativePath: nconf.get('relative_path') || '',
			detectFile: requireNodeBB('file-type').fileTypeFromFile, detectBuffer: requireNodeBB('file-type').fileTypeFromBuffer,
			dimensions: async (input) => {
				const { width, height } = await sharp(input, { failOn: 'error' }).metadata();
				return { width, height };
			},
			sanitizeSvg: requireNodeBB('./src/file').sanitizeSvgData,
		});
	}
	return resources;
}

exports.init = async function ({ router, middleware }) {
	const requireNodeBB = global.nodebb.require;
	const getStorage = exports.getStorage;
	const services = {
		db: requireNodeBB('./src/database'),
		image: requireNodeBB('./src/image'),
		meta: requireNodeBB('./src/meta'),
		privileges: requireNodeBB('./src/privileges'),
		relativePath: requireNodeBB('nconf').get('relative_path') || '',
		getStorage,
	};
	lifecycle = createLifecycle({
		...services, posts: requireNodeBB('./src/posts'), topics: requireNodeBB('./src/topics'),
		baseUrl: requireNodeBB('nconf').get('url'),
	});
	attachments = createAttachments({ ...services, canRead: lifecycle.canRead });
	// 先注册入口，即使存储检查失败也不回退到公开本地文件。
	const read = createReadHandler({ attachments, getStorage, setSafeFileHeaders: middleware.uploads.setSafeFileHeaders });
	router.get('/attachments/:id/:variant/:filename', middleware.authenticateRequest, middleware.redirectToHomeIfBanned, read);
	registerResourceRoutes({ router, middleware, resources: getResources(), getStorage: exports.getStorage,
		file: requireNodeBB('./src/file'), image: services.image, upload: requireNodeBB('./src/middleware/multer'),
		uploadPath: requireNodeBB('nconf').get('upload_path') });
	await ensureStorage();
	// 安装时生成的默认 favicon 也通过私有桶提供；程序内置源文件仍随镜像发布。
	const defaultIcon = requireNodeBB('path').join(requireNodeBB('nconf').get('upload_path'), 'system', 'favicon.ico');
	const file = requireNodeBB('./src/file');
	if (String(services.meta.config['brand:favicon'] || '').endsWith('/assets/uploads/system/favicon.ico') && !await file.exists(defaultIcon)) {
		await file.saveFileToLocal('favicon.ico', 'system', requireNodeBB('path').join(requireNodeBB('nconf').get('base_dir'), 'public', 'favicon.ico'));
	}
	requireNodeBB('winston').info('[private-attachments] MinIO 私有附件桶检查通过');
};

exports.resourceStorage = async data => await getResources().storage(data);
exports.deleteUserResources = async data => { await getResources().deleteOwner('user', data.uid); return data; };
exports.deleteCategoryResources = async data => { await getResources().deleteOwner('category', data.cid); return data; };
exports.renameGroupResources = async data => { await getResources().renameOwner('group', data.old, data.new); return data; };
exports.deleteGroupResources = async data => {
	for (const name of data.groupNames) { await getResources().deleteOwner('group', name); }
	return data;
};

// 使用可等待的 filter Hook，关联与删除完成后原生请求才继续。
for (const method of ['preparePost', 'associateThumb', 'purge', 'hasThumbs', 'getThumbs']) {
	exports[method] = async data => {
		if (!lifecycle) { throw new Error('私有附件存储尚未初始化'); }
		return await lifecycle[method](data);
	};
}

exports.uploadPostFile = async function (data) {
	if (!attachments) {
		throw new Error('私有附件存储尚未初始化');
	}
	return await attachments.upload(data);
};

exports.getStorage = function () {
	if (!storage) {
		throw new Error('私有附件存储尚未初始化');
	}
	return storage;
};
