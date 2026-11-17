'use strict';

$(function () {
	require(['private-attachments/direct-upload', 'composer/uploads'], function (direct, composerUploads) {
		let active = 0;
		window.addEventListener('beforeunload', event => {
			if (active > 0) { event.preventDefault(); event.returnValue = ''; }
		});
		$(window).on('filter:composer.uploadTransport', (_event, transport) => {
			const settings = config.privateAttachmentsDirectUpload;
			if (!settings?.enabled || transport.route !== '/api/post/upload' ||
				!transport.files.some(file => direct.isVideo(file) && file.size >= settings.threshold)) { return; }
			transport.maximumFileSize = file => direct.isVideo(file) ? settings.maxBytes : Number(config.maximumFileSize) * 1024;
			transport.submit = async (options) => {
				const controller = new AbortController();
				const container = $(`.composer[data-uuid="${transport.post_uuid}"]`);
				const box = $('<div class="private-direct-upload" role="status"></div>');
				const label = $('<span></span>');
				const bar = $('<progress max="100" value="0" aria-label="视频上传进度"></progress>');
				const cancel = $('<button type="button" class="btn btn-sm btn-outline-secondary">取消上传</button>');
				box.append(label, bar, cancel).appendTo(container.find('.write').first().length ? container.find('.write').first() : container);
				cancel.on('click', () => { label.text('正在取消上传…'); cancel.prop('disabled', true); controller.abort(); });
				active += 1;
				let completed = 0;
				const total = transport.files.reduce((sum, file) => sum + file.size, 0);
				const started = Date.now();
				const images = [];
				let progressTime = 0;
				function progress(bytes, filename) {
					const value = completed + bytes;
					const percent = Math.min(99, Math.floor(value * 100 / total));
					bar.val(percent);
					const elapsed = Math.max(1, (Date.now() - started) / 1000);
					const speed = value / elapsed;
					label.text(`${filename} · ${percent}% · ${(speed / 1024 / 1024).toFixed(1)} MB/s · 约剩 ${Math.ceil((total - value) / Math.max(1, speed))} 秒`);
					if (Date.now() - progressTime > 300) {
						options.uploadProgress?.(null, value, total, percent);
						progressTime = Date.now();
					}
				}
				try {
					for (const file of transport.files) {
						progress(0, file.name);
						const result = direct.isVideo(file) && file.size >= settings.threshold ?
							await direct.uploadFile(file, { signal: controller.signal, onProgress: bytes => progress(bytes, file.name),
								onState: text => label.text(`${file.name} · ${text}`) }) :
							await direct.normalFile(file, `${config.relative_path}${transport.route}`, options.data.cid, controller.signal);
						images.push(result);
						completed += file.size;
					}
					options.success?.({ response: { images } });
				} catch (err) {
					options.error?.({ status: err.status || 0, responseJSON: { error: err.name === 'AbortError' ? '上传已取消，请重新选择文件上传' : err.message } });
				} finally {
					active -= 1;
					box.remove();
					options.complete?.();
					// 同一编辑器仍有其他批次时保持发布按钮禁用。
					if (composerUploads.inProgress[transport.post_uuid]?.length) { container.find('[data-action="post"]').prop('disabled', true); }
				}
			};
		});
	});
});
