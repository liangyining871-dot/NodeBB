'use strict';

const { connect } = require('./storage');
const { createAttachments } = require('./attachments');
const { createReadHandler } = require('./routes');

let storage;
let attachments;

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
	attachments = createAttachments(services);
	const read = createReadHandler({ attachments, getStorage, setSafeFileHeaders: middleware.uploads.setSafeFileHeaders });
	router.get('/attachments/:id/:variant/:filename', middleware.authenticateRequest, middleware.redirectToHomeIfBanned, read);
	storage = await connect();
	global.nodebb.require('winston').info('[private-attachments] MinIO 私有附件桶检查通过');
};

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
