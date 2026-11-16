'use strict';

$(function () {
	let activeVideo;
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
			const posterUrl = new URL(url);
			posterUrl.searchParams.set('poster', '1');
			const cover = $('<button type="button" class="private-video-cover" aria-label="预览并播放视频"></button>');
			const image = $('<img loading="lazy" alt="视频封面">');
			cover.append(image, $('<span class="private-video-cover-play" aria-hidden="true">▶</span>'));
			// 本地未安装 FFmpeg 时，MP4 等格式仍可由浏览器显示第一帧。
			image.one('error', () => {
				image.remove();
				if (/\.wmv$/i.test(url.pathname)) {
					cover.append($('<span class="private-video-cover-hint">封面暂不可用，点击播放</span>'));
					return;
				}
				const frame = document.createElement('video');
				frame.muted = true;
				frame.preload = 'metadata';
				frame.setAttribute('playsinline', '');
				frame.setAttribute('aria-hidden', 'true');
				frame.addEventListener('error', () => {
					frame.remove();
					cover.append($('<span class="private-video-cover-hint">封面暂不可用，点击播放</span>'));
				});
				frame.src = `${url.href}#t=0.1`;
				cover.prepend(frame);
			});
			image.attr('src', posterUrl.href);
			const download = new URL(url);
			download.searchParams.set('download', '1');
			card.append(cover, $('<span class="private-video-details"></span>').append(
				$('<span class="private-video-name"></span>').text(name), play,
				$('<a class="btn btn-link">下载原文件</a>').attr('href', download.href)));
			$(this).replaceWith(card);
			play.on('click', () => playInline(card, cover, url, name, posterUrl.href));
			cover.on('click', () => playInline(card, cover, url, name, posterUrl.href));
		});
	}

	function playInline(card, cover, url, name, posterUrl) {
		let video = card.find('.private-video-player')[0];
		if (!video) {
			video = document.createElement('video');
			video.className = 'private-video-player';
			video.controls = true;
			video.poster = posterUrl;
			video.setAttribute('playsinline', '');
			video.setAttribute('aria-label', name);
			const source = new URL(url);
			if (/\.wmv$/i.test(source.pathname)) { source.searchParams.set('preview', '1'); }
			const status = $('<span class="private-video-status" role="status">正在加载视频…</span>');
			if (/\.wmv$/i.test(source.pathname)) { status.text('正在加载视频，首次转换需要等待…'); }
			// 替换封面前释放浏览器首帧预览占用的连接。
			cover.find('video').each(function () { this.removeAttribute('src'); this.load(); });
			cover.replaceWith(video);
			card.append(status);
			video.addEventListener('playing', () => status.hide());
			video.addEventListener('error', () => status.text('视频暂时无法播放，请重试或下载原文件。').show());
			video.addEventListener('play', () => {
				if (activeVideo && activeVideo !== video) { activeVideo.pause(); }
				activeVideo = video;
			});
			video.src = source.href;
		}
		// 在点击事件内直接调用 play，保留用户手势，避免还要再点播放器。
		video.play().catch((err) => {
			if (err.name === 'NotAllowedError') {
				card.find('.private-video-status').text('浏览器限制了自动播放，请点击视频控制栏播放。').show();
			}
		});
	}

	$(window).on('action:ajaxify.end action:posts.loaded action:posts.edited', decorate);
	$(window).on('action:ajaxify.start', () => {
		// 切换页面时停止播放和下载。
		$('.private-video-card video').each(function () {
			this.pause();
			this.removeAttribute('src');
			this.load();
		});
		activeVideo = undefined;
	});
	decorate();
});
