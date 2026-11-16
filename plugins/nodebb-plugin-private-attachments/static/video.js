'use strict';

$(function () {
	let closePlayer = () => {};
	function decorate() {
		// 仅处理本站私有附件，兼容旧帖、分页和实时加载的回复。
		$('[component="post/content"] a[href]').each(function () {
			if (this.dataset.videoPreview) { return; }
			const url = new URL(this.href, location.href);
			if (url.origin !== location.origin || !url.pathname.startsWith(`${config.relative_path}/attachments/`) ||
				!/\/original\/[^/]+\.(mp4|wmv|webm|ogg)$/i.test(url.pathname)) { return; }
			this.dataset.videoPreview = '1';
			const name = this.textContent || decodeURIComponent(url.pathname.split('/').pop());
			const card = $('<span class="private-video-card"></span>');
			const play = $('<button type="button" class="btn btn-primary">▶ 播放视频</button>');
			const download = new URL(url);
			download.searchParams.set('download', '1');
			card.append($('<span class="private-video-name"></span>').text(name), play,
				$('<a class="btn btn-link">下载原文件</a>').attr('href', download.href));
			$(this).replaceWith(card);
			play.on('click', () => openPlayer(url, name));
		});
	}

	function openPlayer(url, name) {
		closePlayer();
		const dialog = document.createElement('dialog');
		dialog.className = 'private-video-dialog';
		const title = $('<strong></strong>').text(name);
		const close = $('<button type="button" class="btn btn-light" aria-label="关闭视频">关闭</button>');
		const status = $('<p role="status">正在加载视频；WMV 首次预览需要转换，请稍候…</p>');
		const video = document.createElement('video');
		video.controls = true;
		video.preload = 'metadata';
		video.setAttribute('playsinline', '');
		const controller = new AbortController();
		$(dialog).append($('<div class="private-video-header"></div>').append(title, close), status, video);
		document.body.append(dialog);
		// 关闭和切换页面时停止网络请求，释放播放器资源。
		closePlayer = () => {
			controller.abort();
			video.pause();
			video.removeAttribute('src');
			video.load();
			dialog.remove();
		};
		close.on('click', closePlayer);
		dialog.addEventListener('cancel', (event) => { event.preventDefault(); closePlayer(); });
		video.addEventListener('loadedmetadata', () => status.hide());
		video.addEventListener('error', () => status.text('视频暂时无法播放，可能是编码不兼容，请下载原文件查看。').show());
		dialog.showModal();
		const source = new URL(url);
		if (/\.wmv$/i.test(source.pathname)) { source.searchParams.set('preview', '1'); }
		// HEAD 先等待 WMV 转换完成，播放器随后通过 Range 按需读取。
		fetch(source, { method: 'HEAD', signal: controller.signal }).then((response) => {
			if (!response.ok) { throw new Error('预览不可用'); }
			video.src = source.href;
		}).catch((err) => {
			if (err.name !== 'AbortError') { status.text('预览失败，请稍后重试或下载原文件。'); }
		});
	}

	$(window).on('action:ajaxify.end action:posts.loaded action:posts.edited', decorate);
	$(window).on('action:ajaxify.start', () => closePlayer());
	decorate();
});
