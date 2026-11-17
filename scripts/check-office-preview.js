'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const run = promisify(require('node:child_process').execFile);
const { convertDocument, documentPoster } = require('../plugins/nodebb-plugin-private-attachments/documents');

async function zip(filename, entries) {
	const { ZipArchive } = require('archiver');
	const archive = new ZipArchive();
	const output = createWriteStream(filename);
	const done = new Promise((resolve, reject) => {
		output.on('close', resolve);
		output.on('error', reject);
		archive.on('error', reject);
	});
	archive.pipe(output);
	for (const [name, content] of Object.entries(entries)) { archive.append(content, { name }); }
	await archive.finalize();
	await done;
}

async function checkOfficePreview(directory) {
	await fs.mkdir(directory, { recursive: true });
	const rels = 'http://schemas.openxmlformats.org/package/2006/relationships';
	const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
	const types = 'http://schemas.openxmlformats.org/package/2006/content-types';
	const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
	const sheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
	const defaults = '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>';
	await zip(path.join(directory, 'word.docx'), {
		'[Content_Types].xml': `<Types xmlns="${types}">${defaults}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
		'_rels/.rels': `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="word/document.xml"/></Relationships>`,
		'word/document.xml': `<w:document xmlns:w="${word}"><w:body><w:p><w:r><w:t>Word preview check 文档预览</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
	});
	await zip(path.join(directory, 'workbook.xlsx'), {
		'[Content_Types].xml': `<Types xmlns="${types}">${defaults}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
		'_rels/.rels': `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
		'xl/workbook.xml': `<workbook xmlns="${sheet}" xmlns:r="${office}"><sheets><sheet name="Overview" sheetId="1" r:id="rId1"/><sheet name="Details" sheetId="2" r:id="rId2"/></sheets></workbook>`,
		'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${office}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${office}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
		'xl/worksheets/sheet1.xml': `<worksheet xmlns="${sheet}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SheetOne 表格预览</t></is></c></row><row r="2"><c r="A2"><v>19</v></c></row><row r="3"><c r="A3"><v>23</v></c></row><row r="4"><c r="A4"><f>SUM(A2:A3)</f><v>42</v></c></row></sheetData></worksheet>`,
		'xl/worksheets/sheet2.xml': `<worksheet xmlns="${sheet}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SheetTwo</t></is></c></row></sheetData></worksheet>`,
	});
	// 同时生成旧二进制格式，验证 DOC/XLS 导入而不只检查扩展名。
	for (const [source, format] of [['word.docx', 'doc:MS Word 97'], ['workbook.xlsx', 'xls:MS Excel 97']]) {
		await run(process.env.LIBREOFFICE_PATH || 'soffice', [
			`-env:UserInstallation=${pathToFileURL(path.join(directory, 'profile')).href}`,
			'--headless', '--convert-to', format, '--outdir', directory, path.join(directory, source),
		], { timeout: 120000, windowsHide: true });
	}
	const results = [];
	for (const name of ['word.doc', 'word.docx', 'workbook.xls', 'workbook.xlsx']) {
		const output = path.join(directory, `${name}.pdf`);
		await convertDocument(path.join(directory, name), output);
		assert.equal((await fs.readFile(output)).subarray(0, 5).toString(), '%PDF-');
		const textTool = process.env.PDFTOPPM_PATH ? path.join(path.dirname(process.env.PDFTOPPM_PATH), process.platform === 'win32' ? 'pdftotext.exe' : 'pdftotext') : 'pdftotext';
		const { stdout } = await run(textTool, [output, '-'], { timeout: 30000, windowsHide: true });
		if (name.startsWith('word')) {
			assert.match(stdout, /Word preview check/);
			assert.match(stdout, /文档预览/);
		} else {
			assert.match(stdout, /SheetOne/);
			assert.match(stdout, /SheetTwo/);
			assert.match(stdout, /42/);
		}
		const poster = path.join(directory, `${name}.png`);
		await documentPoster(output, poster);
		assert.equal((await fs.readFile(poster)).subarray(1, 4).toString(), 'PNG');
		results.push(name);
	}
	return results;
}

module.exports = { checkOfficePreview };

if (require.main === module) {
	checkOfficePreview(path.resolve(process.argv[2] || 'backups/office-preview')).then(results => {
		console.log(`真实 Office 转换和首页封面检查通过：${results.join(', ')}（含中文、多工作表、公式结果）`);
	}).catch(err => { console.error(err.message); process.exitCode = 1; });
}
