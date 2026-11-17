'use strict';

// 只检查发布文件，不连接数据库、不修改论坛配置；--image 另验证真实转码。
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const root = path.resolve(__dirname, '..');
const run = promisify(execFile);

async function main() {
	if (Number(process.versions.node.split('.')[0]) < 22) { throw new Error('请使用 Node.js 24，当前 Node.js 版本过低'); }
	const snapshot = await require('../src/initial-appearance').prepare({
		db: { async getObjectField() {}, async setObjectField() {} },
		snapshotPath: path.join(root, 'install/docker/appearance.snapshot.json'),
	});
	for (const id of ['nodebb-plugin-private-attachments', 'nodebb-plugin-sso-uniportal']) {
		if (!snapshot.plugins.some(plugin => plugin.id === id)) { throw new Error(`快照缺少必要插件：${id}`); }
	}
	const extensions = String(snapshot.localPolicies.allowedFileExtensions || '').split(',');
	if (extensions[0] && !['mp4', 'wmv', 'webm', 'ogg'].every(ext => extensions.includes(ext))) {
		throw new Error('快照的上传白名单缺少视频格式，请更新本地配置后重新导出');
	}
	const logo = snapshot.config['brand:logo'];
	if (logo?.startsWith('/assets/')) { await fs.access(path.join(root, 'public', logo.slice('/assets/'.length))); }
	for (const [filename, marker] of [
		['build/public/templates/categories.js', 'category-media-preview'],
		['build/public/nodebb.min.js', 'private-video-player'],
		['build/public/nodebb.min.js', 'private-document-dialog'],
		['build/public/nodebb.min.js', 'private-direct-upload'],
		['node_modules/nodebb-plugin-composer-default/static/lib/composer/uploads.js', 'filter:composer.uploadTransport'],
		['build/public/templates/partials/topics_list.tpl', 'data-document-src'],
		['build/public/client.css', '.category-media-preview'],
		['build/public/client.css', '.private-document-dialog'],
	]) {
		if (!(await fs.readFile(path.join(root, filename), 'utf8')).includes(marker)) {
			throw new Error(`构建产物缺少媒体预览：${filename}`);
		}
	}
	console.log(`快照及构建检查通过：${snapshot.exportedAt}，${snapshot.plugins.length} 个插件，上传上限 ${snapshot.localPolicies.maximumFileSize} KB`);
	if (process.argv.includes('--compose')) {
		// 解析结果仅用于校验，不输出含数据库、MinIO 和企业登录凭据的完整配置。
		let compose;
		try {
			const result = await run('docker', ['compose', '-f', path.join(root, 'docker-compose.production.yml'), 'config', '--format', 'json']);
			compose = JSON.parse(result.stdout);
		} catch { throw new Error('生产 Compose 解析失败，请检查 Docker Compose 和配置文件'); }
		const service = compose.services?.nodebb;
		const env = service?.environment || {};
		const direct = require('../plugins/nodebb-plugin-private-attachments/multipart-storage').readDirectConfig(env);
		if (direct.enabled && new URL(env.url).protocol === 'https:' && new URL(direct.publicUrl).protocol !== 'https:') {
			throw new Error('HTTPS 论坛必须使用 HTTPS MinIO 直传入口');
		}
		if (env.url !== snapshot.targetUrl || env.INITIAL_APPEARANCE_SNAPSHOT !== '/usr/src/app/install/docker/appearance.snapshot.json' ||
			env.FFMPEG_PATH !== '/usr/bin/ffmpeg') { throw new Error('Compose 的域名、外观快照或 FFmpeg 路径与发布配置不一致'); }
		if (env.UNIPORTAL_ENABLED === 'true' && env.UNIPORTAL_REDIRECT_URI !== `${env.url}/auth/uniportal/callback`) {
			throw new Error('企业登录回调与论坛域名不一致');
		}
		const targets = (service.volumes || []).map(volume => volume.target);
		if (!targets.includes('/opt/config') || !targets.includes('/usr/src/app/public/uploads') ||
			targets.some(target => ['/usr/src/app', '/usr/src/app/build', '/usr/src/app/node_modules'].includes(target))) {
			throw new Error('Compose 必须持久化配置和上传目录，且不能覆盖镜像中的程序和构建产物');
		}
		console.log('Compose 检查通过：域名与回调一致，快照及 FFmpeg 路径正确，挂载保留镜像构建产物');
	}
	if (process.argv.includes('--image')) {
		if (process.platform !== 'linux') { throw new Error('--image 应在 Linux 发布镜像内运行'); }
		if (process.env.FFMPEG_PATH && !path.isAbsolute(process.env.FFMPEG_PATH)) { throw new Error('FFMPEG_PATH 必须是容器内的绝对路径'); }
		const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nodebb-release-'));
		try {
			const input = path.join(directory, 'sample.wmv');
			const output = path.join(directory, 'sample.mp4');
			const poster = path.join(directory, 'poster.jpg');
			await run(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10',
				'-t', '0.5', '-c:v', 'wmv2', input], { timeout: 30000 });
			const video = require('../plugins/nodebb-plugin-private-attachments/video');
			await video.convertVideo(input, output);
			await video.extractPoster(input, poster);
			if (!(await fs.stat(output)).size || !(await fs.stat(poster)).size) { throw new Error('FFmpeg 生成了空文件'); }
			const officeFormats = await require('./check-office-preview').checkOfficePreview(path.join(directory, 'office'));
			console.log(`Office 预览检查通过：${officeFormats.join(', ')}，含中文、多工作表及首页封面`);
			for (const filename of ['.env', 'config.json']) {
				try { await fs.access(path.join(root, filename)); } catch (err) {
					if (err.code === 'ENOENT') { continue; }
					throw err;
				}
				throw new Error(`发布镜像意外包含本地配置：${filename}`);
			}
			console.log('镜像检查通过：真实 WMV → MP4 转换、封面提取、本地配置隔离');
		} finally { await fs.rm(directory, { recursive: true, force: true }); }
	}
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
