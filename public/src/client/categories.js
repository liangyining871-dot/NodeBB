'use strict';


define('forum/categories', ['categorySelector'], function (categorySelector) {
	const categories = {};

	categories.init = async function () {
		app.enterRoom('categories');
		// 首页收到删除事件后立即移除预览，不等待用户刷新。
		const removeDeletedPreview = data => $(`[component="category/posts"][data-tid="${data.tid}"]`).remove();
		socket.on('event:topic_deleted', removeDeletedPreview);
		$(window).one('action:ajaxify.start', () => socket.removeListener('event:topic_deleted', removeDeletedPreview));

		categorySelector.init($('[component="category-selector"]'), {
			privilege: 'find',
			onSelect: function (category) {
				ajaxify.go('/category/' + category.cid);
			},
		});

	};

	return categories;
});
