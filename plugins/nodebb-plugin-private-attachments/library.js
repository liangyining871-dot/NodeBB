'use strict';

const { connect } = require('./storage');
let storage;

exports.init = async function () {
	// 启动时只检查存储，不接管上传和下载。
	storage = await connect();
	global.nodebb.require('winston').info('[private-attachments] MinIO 私有附件桶检查通过');
};

exports.getStorage = function () {
	if (!storage) {
		throw new Error('私有附件存储尚未初始化');
	}
	return storage;
};
