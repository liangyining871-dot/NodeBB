'use strict';

$(function () {
	function openDocument(url, name) {
		const dialog = document.createElement('dialog');
		dialog.className = 'private-document-dialog';
		const toolbar = $('<div class="private-document-toolbar"></div>');
		const close = $('<button type="button" class="btn btn-secondary">关闭</button>');
		toolbar.append($('<strong></strong>').text(name),
			$('<a class="btn btn-link" target="_blank" rel="noopener">新窗口阅读</a>').attr('href', url.href), close);
		const frame = $('<iframe class="private-document-frame"></iframe>').attr({ src: url.href, title: name });
		$(dialog).append(toolbar, $('<p role="status">首次打开文档可能需要稍候；若未显示内容，请使用“新窗口阅读”。</p>'), frame);
		document.body.appendChild(dialog);
		close.on('click', () => dialog.close());
		dialog.addEventListener('close', () => dialog.remove(), { once: true });
		dialog.showModal();
	}

	function decorate() {
		$('[component="post/content"] a[href]').each(function () {
			if (this.dataset.documentReady || this.closest('.private-document-card')) { return; }
			const url = new URL(this.href, location.href);
			if (url.origin !== location.origin || !url.pathname.startsWith(`${config.relative_path}/attachments/`) ||
				!/\/original\/[^/]+\.(pdf|ppt|pptx|doc|docx|xls|xlsx)$/i.test(url.pathname) || url.searchParams.get('download') === '1') { return; }
			this.dataset.documentReady = '1';
			const name = this.textContent || decodeURIComponent(url.pathname.split('/').pop());
			const download = new URL(url);
			download.searchParams.set('download', '1');
			download.searchParams.delete('poster');
			download.searchParams.delete('preview');
			url.searchParams.delete('poster');
			url.searchParams.set('preview', '1');
			const card = $('<span class="private-document-card"></span>');
			const toolbar = $('<span class="private-document-toolbar"></span>');
			toolbar.append($('<strong></strong>').text(name),
				$('<a class="btn btn-link" target="_blank" rel="noopener">新窗口阅读</a>').attr('href', url.href),
				$('<a class="btn btn-link">下载原文件</a>').attr('href', download.href));
			const source = new URL(url);
			source.hash = 'view=FitH';
			const frame = $('<iframe class="private-document-frame private-document-inline" loading="eager"></iframe>')
				.attr({ src: source.href, title: name });
			card.append(toolbar, frame);
			$(this).replaceWith(card);
		});
		$('.category-media-preview[data-document-src]').each(function () {
			if (!this.dataset.documentSrc || this.dataset.documentReady) { return; }
			this.dataset.documentReady = '1';
			const url = new URL(this.dataset.documentSrc, location.href);
			if (url.origin !== location.origin) { return; }
			$(this).on('click', (event) => {
				event.preventDefault();
				event.stopImmediatePropagation();
				openDocument(url, $(this).find('img').attr('alt') || '文档预览');
			});
		});
	}
	$(window).on('action:ajaxify.end action:posts.loaded action:posts.edited action:topics.loaded', decorate);
	$(window).on('action:ajaxify.start', () => {
		$('.private-document-dialog, .private-document-inline').remove();
	});
	decorate();
});
