'use strict';

// 独立检查命令不连接论坛数据库，不上传或删除对象。
const { connect } = require('./storage');

connect().then(() => {
	console.log('MinIO 私有附件桶检查通过');
}).catch((err) => {
	console.error(err.message);
	process.exitCode = 1;
});
