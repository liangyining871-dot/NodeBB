'use strict';

$(function () {
	require(['hooks'], function (hooks) {
		// 只给新主题和主帖编辑增加字段，回复保持原来的编辑器。
		hooks.on('action:composer.enhanced', function ({ postContainer, postData, draft }) {
			if (!postContainer.find('input.title').length || postContainer.find('.external-topic-fields').length) { return; }
			const values = draft && Object.hasOwn(draft, 'externalUrl') ? draft : { ...postData.topic, ...postData };
			const fields = $('<div class="external-topic-fields"></div>');
			const toggle = $('<label class="d-flex align-items-center gap-2"><input type="checkbox" class="form-check-input m-0"> 外部链接</label>');
			const options = $('<div class="external-topic-options"></div>');
			const url = $('<input type="url" class="form-control form-control-sm" aria-label="外部链接" placeholder="外部链接（HTTP / HTTPS）" maxlength="2048">').val(values.externalUrl || '');
			const cover = $('<input type="url" class="form-control form-control-sm" aria-label="可选封面链接" placeholder="封面图片链接（可选，也可在正文上传图片）" maxlength="2048">').val(values.externalCover || '');
			options.append(url, cover, $('<small class="text-muted">正文填写简短介绍；发布后点击卡片将在新标签页打开链接。</small>'));
			fields.append(toggle, options).insertAfter(postContainer.find('.title-container').first());
			const checkbox = toggle.find('input').prop('checked', !!values.externalUrl);
			function update() {
				options.toggleClass('hidden', !checkbox.prop('checked'));
				postData.externalUrl = checkbox.prop('checked') ? url.val().trim() : '';
				postData.externalCover = checkbox.prop('checked') ? cover.val().trim() : '';
			}
			fields.on('input change', function () {
				update();
				postData.modified = true;
				// 复用原生草稿保存的防抖事件，输入链接后也能恢复草稿。
				postContainer.find('textarea').first().trigger('keyup');
			});
			update();
		});

		hooks.on('filter:composer.check', function (data) {
			const fields = data.postContainer.find('.external-topic-fields');
			if (!fields.find('input[type="checkbox"]').prop('checked')) { return data; }
			for (const [index, input] of fields.find('input[type="url"]').toArray().entries()) {
				const value = input.value.trim();
				if (!value && index === 1) { continue; }
				try {
					const url = new URL(value);
					if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { throw new Error(); }
				} catch (_err) { data.error = '请填写有效的 HTTP 或 HTTPS 外部链接、封面链接（不含账号密码）'; break; }
			}
			return data;
		});

		// 自定义字段随原生提交和草稿一起保存，不增加独立写入请求。
		function copyFields(container, target) {
			const fields = container.find('.external-topic-fields');
			if (!fields.length) { return; }
			const enabled = fields.find('input[type="checkbox"]').prop('checked');
			const inputs = fields.find('input[type="url"]');
			target.externalUrl = enabled ? inputs.eq(0).val().trim() : '';
			target.externalCover = enabled ? inputs.eq(1).val().trim() : '';
		}
		hooks.on('filter:composer.submit', function (data) {
			copyFields(data.composerEl, data.composerData);
			return data;
		});
		hooks.on('filter:composer.drafts.save', function (data) {
			copyFields(data.postContainer, data.draft);
			return data;
		});
	});
});
