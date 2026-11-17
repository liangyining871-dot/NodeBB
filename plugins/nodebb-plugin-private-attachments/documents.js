'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const run = promisify(execFile);

const isDocument = record => /\.(pdf|ppt|pptx|doc|docx|xls|xlsx)$/i.test(record.name);

async function convertDocument(input, output) {
	const extension = path.extname(input).toLowerCase();
	const filter = { '.doc': 'writer_pdf_Export', '.docx': 'writer_pdf_Export',
		'.xls': 'calc_pdf_Export', '.xlsx': 'calc_pdf_Export',
		'.ppt': 'impress_pdf_Export', '.pptx': 'impress_pdf_Export' }[extension];
	if (!filter) { throw new Error('不支持的文档转换格式'); }
	await run(process.env.LIBREOFFICE_PATH || 'soffice', [
		`-env:UserInstallation=${pathToFileURL(path.join(path.dirname(input), 'profile')).href}`,
		'--headless', '--convert-to', `pdf:${filter}`, '--outdir', path.dirname(output), input,
	], { timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true });
	await fs.rename(path.join(path.dirname(output), `${path.parse(input).name}.pdf`), output);
}

async function documentPoster(input, output) {
	await run(process.env.PDFTOPPM_PATH || 'pdftoppm', [
		'-f', '1', '-singlefile', '-scale-to', '640', '-png', input, output.slice(0, -4),
	], { timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true });
}

function createDocumentPreview({ db, getStorage, convert = convertDocument, poster = documentPoster }) {
	let queue = Promise.resolve();
	const pending = new Map();
	return function preview(record, variant = 'document') {
		if (!isDocument(record) || !['document', 'documentPoster'].includes(variant)) {
			throw new Error('不支持的文档预览');
		}
		const taskKey = `${record.id}:${variant}`;
		if (pending.has(taskKey)) { return pending.get(taskKey); }
		const task = queue.then(async () => {
			const key = `privateAttachment:${record.id}`;
			const current = await db.getObject(key);
			if (!current || !['pending', 'attached'].includes(current.status)) { throw new Error('附件不可用'); }
			const variants = JSON.parse(current.variants);
			if (variant === 'document' && /\.pdf$/i.test(record.name)) { return variants.original; }
			if (variants[variant]) { return variants[variant]; }
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nodebb-document-'));
			const { client, bucket } = getStorage();
			try {
				const input = path.join(dir, `original${path.extname(record.name).toLowerCase()}`);
				const pdf = path.join(dir, 'document.pdf');
				const save = async (name, filename, mime) => {
					const file = { objectKey: `${record.id}/${filename}`, mime, size: (await fs.stat(path.join(dir, filename))).size };
					await client.fPutObject(bucket, file.objectKey, path.join(dir, filename), { 'Content-Type': mime });
					const latest = await db.getObject(key);
					if (!latest || !['pending', 'attached'].includes(latest.status)) {
						await client.removeObject(bucket, file.objectKey);
						throw new Error('附件不可用');
					}
					await db.setObjectField(key, 'variants', JSON.stringify({ ...JSON.parse(latest.variants), [name]: file }));
					return file;
				};
				if (variants.document) {
					await pipeline(await client.getObject(bucket, variants.document.objectKey), createWriteStream(pdf));
				} else {
					await pipeline(await client.getObject(bucket, variants.original.objectKey), createWriteStream(input));
					if (/\.pdf$/i.test(record.name)) { await fs.rename(input, pdf); } else {
						await convert(input, pdf);
						variants.document = await save('document', 'document.pdf', 'application/pdf');
					}
				}
				if (variant === 'document') { return variants.document; }
				await poster(pdf, path.join(dir, 'document-poster.png'));
				return await save('documentPoster', 'document-poster.png', 'image/png');
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		});
		queue = task.catch(() => {});
		const result = task.finally(() => pending.delete(taskKey));
		pending.set(taskKey, result);
		return result;
	};
}

module.exports = { isDocument, createDocumentPreview, convertDocument, documentPoster };
