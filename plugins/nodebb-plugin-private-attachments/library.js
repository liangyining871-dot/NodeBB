'use strict';

const { connect } = require('./storage');
const { createAttachments } = require('./attachments');
const { createReadHandler } = require('./routes');
const { createLifecycle } = require('./lifecycle');
const { createResources } = require('./resources');
const { registerResourceRoutes } = require('./resource-routes');
const { createVideoPreview } = require('./video');
const { createDocumentPreview } = require('./documents');
const { createSummaryMedia } = require('./summary-media');
const externalTopics = require('./external-topics');
const { readDirectConfig, createMultipartStorage } = require('./multipart-storage');
const { createDirectUploads, registerDirectUploadRoutes } = require('./direct-uploads');

exports.directUploadConfig = async (data) => {
	const config = readDirectConfig();
	data.privateAttachmentsDirectUpload = { enabled: config.enabled, maxBytes: config.maxBytes, threshold: config.threshold };
	return data;
};

exports.validateExternalTopic = async data => externalTopics.validate(data);
exports.validateExternalEdit = async (payload) => { externalTopics.validate(payload.data); return payload; };
exports.saveExternalTopic = async payload => externalTopics.save(payload);
exports.externalTopicCards = async data => externalTopics.decorate(data);
exports.externalComposer = async (data) => {
	if (!data.isMain) { return data; }
	const posts = global.nodebb.require('./src/posts');
	const topics = global.nodebb.require('./src/topics');
	const tid = await posts.getPostField(data.pid, 'tid');
	Object.assign(data, await topics.getTopicFields(tid, ['externalUrl', 'externalCover']));
	return data;
};

let storage;
let attachments;
let lifecycle;
let resources;
let connection;
let previewSummaries;

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
	previewSummaries = createSummaryMedia({ ...services, posts: requireNodeBB('./src/posts'),
		canRead: lifecycle.canRead, baseUrl: requireNodeBB('nconf').get('url') });
	// 先注册入口，即使存储检查失败也不回退到公开本地文件。
	const read = createReadHandler({ attachments, getStorage, setSafeFileHeaders: middleware.uploads.setSafeFileHeaders,
		documentPreview: createDocumentPreview({ db: services.db, getStorage }),
		videoPreview: createVideoPreview({ db: services.db, getStorage }) });
	router.get('/attachments/:id/:variant/:filename', middleware.authenticateRequest, middleware.redirectToHomeIfBanned, read);
	registerResourceRoutes({ router, middleware, resources: getResources(), getStorage: exports.getStorage,
		file: requireNodeBB('./src/file'), image: services.image, upload: requireNodeBB('./src/middleware/multer'),
		uploadPath: requireNodeBB('nconf').get('upload_path') });
	await ensureStorage();
	const directConfig = readDirectConfig();
	if (directConfig.enabled) {
		const file = requireNodeBB('./src/file');
		const direct = createDirectUploads({ ...services, config: directConfig,
			storage: createMultipartStorage({ getStorage, config: directConfig }),
			detectBuffer: requireNodeBB('file-type').fileTypeFromBuffer,
			allowedExtensions: file.allowedExtensions, blockedExtensions: file.blockedExtensions });
		registerDirectUploadRoutes({ router, middleware, service: direct });
		const cleanup = () => direct.cleanup().catch(() => requireNodeBB('winston').warn('[private-attachments] 过期上传任务清理失败，将稍后重试'));
		await cleanup();
		setInterval(cleanup, 15 * 60 * 1000).unref();
	}
	// 安装时生成的默认 favicon 也通过私有桶提供；程序内置源文件仍随镜像发布。
	const defaultIcon = requireNodeBB('path').join(requireNodeBB('nconf').get('upload_path'), 'system', 'favicon.ico');
	const file = requireNodeBB('./src/file');
	if (String(services.meta.config['brand:favicon'] || '').endsWith('/assets/uploads/system/favicon.ico') && !await file.exists(defaultIcon)) {
		await file.saveFileToLocal('favicon.ico', 'system', requireNodeBB('path').join(requireNodeBB('nconf').get('base_dir'), 'public', 'favicon.ico'));
	}
	requireNodeBB('winston').info('[private-attachments] MinIO 私有附件桶检查通过');
};

exports.resourceStorage = async data => await getResources().storage(data);
exports.previewSummaries = async data => (previewSummaries ? await previewSummaries(data) : data);
exports.previewTopics = async (data) => {
	if (!previewSummaries || !data.topics?.length) { return data; }
	// 列表以主帖为封面来源，复用摘要取图及附件鉴权，不因最后一条回复无图而丢失封面。
	const pending = data.topics.filter(topic => String(topic.teaser?.pid) !== String(topic.mainPid));
	data.topics.forEach((topic) => { topic.mediaPreview = topic.teaser?.mediaPreview; });
	const teasers = pending.map(topic => ({ pid: topic.mainPid }));
	await previewSummaries({ teasers, uid: data.uid });
	pending.forEach((topic, index) => { topic.mediaPreview = teasers[index].mediaPreview; });
	return data;
};
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
