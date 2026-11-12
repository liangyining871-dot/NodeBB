'use strict';

const { connect } = require('./storage');
const { createAttachments } = require('./attachments');
const { createReadHandler } = require('./routes');
const { createLifecycle } = require('./lifecycle');

let storage;
let attachments;
let lifecycle;

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
	const read = createReadHandler({ attachments, getStorage, setSafeFileHeaders: middleware.uploads.setSafeFileHeaders });
	router.get('/attachments/:id/:variant/:filename', middleware.authenticateRequest, middleware.redirectToHomeIfBanned, read);
	storage = await connect();
	global.nodebb.require('winston').info('[private-attachments] MinIO 私有附件桶检查通过');
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
