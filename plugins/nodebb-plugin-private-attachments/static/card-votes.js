'use strict';

$(function () {
	require(['api', 'alerts'], function (api, alerts) {
		const pending = new Set();
		$(document).on('click', '.topic-card-vote', async function (event) {
			event.preventDefault();
			event.stopPropagation();
			if (!app.user.uid) { ajaxify.go('login'); return; }
			const pid = this.dataset.votePid;
			if (!/^\d+$/.test(pid || '') || pending.has(pid)) { return; }
			pending.add(pid);
			const buttons = $('.topic-card-vote').filter(function () { return this.dataset.votePid === pid; });
			const upvoted = this.dataset.upvoted === 'true';
			const downvoted = this.dataset.downvoted === 'true';
			buttons.prop('disabled', true).attr('aria-busy', 'true');
			try {
				await api[upvoted ? 'del' : 'put'](`/posts/${encodeURIComponent(pid)}/vote`, { delta: 1 });
				const change = upvoted ? -1 : (downvoted ? 2 : 1);
				buttons.each(function () {
					const button = $(this);
					const count = button.find('.topic-card-vote-count');
					const votes = Number(count.attr('data-votes')) || 0;
					count.attr('data-votes', votes + change).text(votes + change);
					button.attr({ 'data-upvoted': String(!upvoted), 'data-downvoted': 'false',
						'aria-pressed': String(!upvoted), 'title': upvoted ? '点赞' : '取消点赞',
						'aria-label': upvoted ? '点赞' : '取消点赞' }).toggleClass('upvoted', !upvoted);
				});
			} catch (err) {
				alerts.error(err.message || '点赞失败，请稍后重试');
			} finally {
				pending.delete(pid);
				buttons.prop('disabled', false).removeAttr('aria-busy');
			}
		});
	});
});
