'use strict';

// 独立运行，不加载 NodeBB、不访问数据库。Node.js 18+，无第三方依赖。
// PowerShell:
//   $env:AVATAR_UID = '企业账号'
//   $env:AVATAR_ACCESS_TOKEN = '有效的用户 access_token'
//   node scripts/test-avatar.js
// 可选：AVATAR_SIZE、AVATAR_OUTPUT、AVATAR_URL_TEMPLATE、AVATAR_AUTH_SCHEME、HTTP_TIMEOUT_MS。
// AVATAR_AUTH_SCHEME 默认 Bearer，设为空字符串则直接发送 token。

const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
	if (process.argv.includes('--help')) {
		console.log('必填环境变量：AVATAR_UID、AVATAR_ACCESS_TOKEN\n可选：AVATAR_SIZE（120）、AVATAR_OUTPUT（avatar-test.jpg）、AVATAR_URL_TEMPLATE、AVATAR_AUTH_SCHEME（Bearer）、HTTP_TIMEOUT_MS（10000）\n运行：node scripts/test-avatar.js\n仅测试头像下载；不会执行 OAuth 登录或刷新 token。');
		return;
	}
	if (typeof fetch !== 'function') { throw new Error('请使用 Node.js 18 或更高版本。'); }
	const uid = (process.env.AVATAR_UID || '').trim();
	const token = (process.env.AVATAR_ACCESS_TOKEN || '').trim();
	if (!uid || !token) { throw new Error('请先设置 AVATAR_UID 和 AVATAR_ACCESS_TOKEN，token 只填写原始值，不含 Bearer 前缀。'); }
	const size = Number(process.env.AVATAR_SIZE || 120);
	const timeout = Number(process.env.HTTP_TIMEOUT_MS || 10000);
	if (!Number.isSafeInteger(size) || size <= 0) { throw new Error('AVATAR_SIZE 必须为正整数。'); }
	if (!Number.isSafeInteger(timeout) || timeout <= 0) { throw new Error('HTTP_TIMEOUT_MS 必须为正整数。'); }
	const template = (process.env.AVATAR_URL_TEMPLATE ?? 'http://w3-beta.huawei.com/wsres/soaservices/yellowpage/face/w3account/{uid}/{size}/1/face.jpg').trim();
	if (!template.includes('{uid}') || !template.includes('{size}')) { throw new Error('AVATAR_URL_TEMPLATE 必须包含 {uid} 和 {size}。'); }
	const url = new URL(template.replaceAll('{uid}', encodeURIComponent(uid)).replaceAll('{size}', String(size)));
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { throw new Error('头像地址必须是无内嵌凭据的 HTTP/HTTPS 地址。'); }
	const scheme = (process.env.AVATAR_AUTH_SCHEME ?? 'Bearer').trim();
	const response = await fetch(url, {
		headers: { Authorization: scheme ? `${scheme} ${token}` : token },
		redirect: 'manual',
		signal: AbortSignal.timeout(timeout),
	});
	console.log(`HTTP ${response.status}`);
	if (response.status >= 300 && response.status < 400) {
		throw new Error('接口返回重定向；请确认头像地址，脚本不会向重定向地址转发 token。');
	}
	if (!response.ok) {
		throw new Error(response.status === 401 || response.status === 403 ? '认证失败：请检查 token 是否过期、Bearer 前缀及头像接口权限。' : '头像请求失败，请检查接口地址和上游服务。');
	}
	const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
	const data = Buffer.from(await response.arrayBuffer());
	if (!data.length) { throw new Error('接口返回空内容。'); }
	// 避免把登录页或 JSON 错误保存成头像。
	const jpeg = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
	const png = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	const gif = ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'));
	const webp = data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
	if (!jpeg && !png && !gif && !webp) {
		console.error(`响应信息：Content-Type=${type || '未提供'}，${data.length} 字节`);
		if (process.argv.includes('--diagnose')) {
			const body = data.toString('utf8');
			const textual = /^(text\/|application\/(json|xml|problem\+json))/.test(type) || /^[\s\uFEFF]*[<{[]/.test(body);
			if (textual) {
				const preview = body.replaceAll(token, '[已遮蔽令牌]')
					.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [已遮蔽]')
					.replace(/(["']?(?:access_token|refresh_token|id_token|authorization|client_secret|token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}<]+)/gi, '$1[已遮蔽]')
					.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 800);
				console.error(`正文摘要（分享前请检查个人信息）：${preview}`);
			} else {
				console.error(`前 16 字节（十六进制）：${data.subarray(0, 16).toString('hex')}`);
			}
		} else {
			console.error('可添加 --diagnose 查看正文摘要，排查登录页或接口错误提示。');
		}
		throw new Error('返回内容不是可识别的 JPEG/PNG/GIF/WebP 图片，未保存。');
	}
	const extension = jpeg ? 'jpg' : png ? 'png' : gif ? 'gif' : 'webp';
	const output = path.resolve(process.env.AVATAR_OUTPUT || `avatar-test.${extension}`);
	await fs.writeFile(output, data, { flag: 'wx' });
	console.log(`获取成功：${data.length} 字节，Content-Type=${type || '未提供'}\n保存位置：${output}`);
}

main().catch((err) => {
	// 不输出请求头或错误堆栈；正文摘要仅在 --diagnose 时输出。
	const code = err.cause?.code || err.code;
	if (code === 'EEXIST') {
		console.error('测试失败：输出文件已存在，请设置其他 AVATAR_OUTPUT 或移动旧文件。');
	} else if (code) {
		console.error(`测试失败：网络或文件错误 ${code}，请检查内网 DNS、连接及保存目录。`);
	} else {
		console.error(`测试失败：${err.name === 'TimeoutError' ? '请求超时。' : err.message}`);
	}
	process.exitCode = 1;
});
