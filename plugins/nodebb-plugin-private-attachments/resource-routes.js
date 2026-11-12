'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { createReadHandler } = require('./routes');

function registerResourceRoutes({ router, middleware, resources, getStorage, file, image, upload, uploadPath }) {
	const read = createReadHandler({ attachments: resources, getStorage, inlineSvg: true,
		setSafeFileHeaders(res) { res.set('X-Content-Type-Options', 'nosniff'); } });
	const serve = folder => async (req, res) => {
		const name = folder ? `${folder}/${req.params[0]}` : req.params[0];
		req.params.id = resources.logicalPath(path.join(uploadPath, name));
		if (!req.params.id) { return res.status(404).end(); }
		await read(req, res);
	};
	// 先于静态文件路由注册，资源不存在或鉴权失败时不回退到磁盘副本。
	const authentication = [middleware.authenticateRequest, middleware.redirectToHomeIfBanned];
	router.get(/^\/assets\/uploads\/(.+)$/, authentication, serve());
	router.get(/^\/assets\/plugins\/nodebb-plugin-emoji\/emoji\/customizations\/(.+)$/, authentication, serve('emoji'));
	// 原表情插件直接写入上传目录；在其路由之前接管，保留原有请求和返回格式。
	router.post('/api/admin/plugins/emoji/upload', middleware.ensureLoggedIn, middleware.admin.checkPrivileges,
		upload.single('emojiImage'), middleware.applyCSRF, async (req, res) => {
			try {
				const name = path.basename(String(req.body.fileName || '').replace(/\\/g, '/'));
				if (!req.file || !name || ['.', '..'].includes(name)) { return res.sendStatus(400); }
				await image.isFileTypeAllowed(req.file.path);
				await image.checkDimensions(req.file.path);
				await file.writeBuffer(path.join(uploadPath, 'emoji', name), await fs.readFile(req.file.path));
				res.sendStatus(200);
			} catch (_err) { res.status(503).json({ error: '表情保存失败，请检查图片和存储配置' }); }
		});
}

module.exports = { registerResourceRoutes };
