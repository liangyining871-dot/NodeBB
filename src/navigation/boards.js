'use strict';

const categories = require('../categories');
const privileges = require('../privileges');
const nconf = require('nconf');

// 每次按当前用户权限生成，板块增删、改名和排序不需要同步维护导航配置。
module.exports = async function boardNavigation(uid) {
	let cids = await categories.getAllCidsFromSet('categories:cid');
	cids = await privileges.categories.filterCids('find', cids, uid);
	cids = await privileges.categories.filterCids('read', cids, uid);
	cids = await privileges.categories.filterCids('topics:read', cids, uid);
	const boards = await categories.getCategoriesFields(cids, ['cid', 'name', 'isSection', 'link']);
	const prefix = nconf.get('relative_path') || '';
	const item = (text, route) => ({
		text, title: text, route, class: 'board-navigation', textClass: '', iconClass: '', enabled: true, groups: [],
	});
	return [item('全部', `${prefix}/recent`), ...boards.filter(board => board?.cid && !board.isSection && !board.link)
		.map(board => item(board.name, `${prefix}/recent?cid=${board.cid}`))];
};
