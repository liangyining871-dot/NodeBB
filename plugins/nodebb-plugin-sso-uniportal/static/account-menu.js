'use strict';

(() => {
	const root = globalThis;
	if (!(Number(root.app?.user?.uid) > 0) || root.app.user.isAdmin) { return; }
	const avatar = '#user_dropdown, [component="header/avatar"]';

	function disableAvatar() {
		// 只禁用导航头像，帖子中的头像和管理员菜单保持原样。
		root.document.querySelectorAll(avatar).forEach((element) => {
			// Persona/Lavender 的提示在外层 user_label，部分主题也在头像子元素上设置提示。
			const label = element.closest('#user_label') || element;
			[label, ...label.querySelectorAll('*')].forEach((target) => {
				root.bootstrap?.Tooltip?.getInstance(target)?.dispose();
				for (const attribute of ['title', 'data-bs-title', 'data-bs-original-title', 'data-original-title', 'data-manual-tooltip']) {
					target.removeAttribute(attribute);
				}
				if (target.getAttribute('data-bs-toggle') === 'tooltip') { target.removeAttribute('data-bs-toggle'); }
			});
			element.removeAttribute('href');
			element.removeAttribute('data-bs-toggle');
			element.setAttribute('aria-disabled', 'true');
			element.setAttribute('aria-expanded', 'false');
			element.setAttribute('tabindex', '-1');
			element.style.cursor = 'default';
		});
		root.document.querySelectorAll('[component="header/usercontrol"]').forEach((menu) => {
			menu.hidden = true;
			menu.classList.remove('show');
		});
	}

	// 在主题的下拉事件之前拦截鼠标及键盘操作，不修改后端设置权限。
	for (const event of ['click', 'keydown']) {
		root.document.addEventListener(event, (e) => {
			if (event === 'keydown' && !['Enter', ' '].includes(e.key)) { return; }
			if (e.target.closest?.(avatar)) { e.preventDefault(); e.stopImmediatePropagation(); }
		}, true);
	}
	disableAvatar();
	root.app.require('hooks').then((hooks) => {
		hooks.on('action:app.load', disableAvatar);
		hooks.on('action:ajaxify.end', disableAvatar);
	});
})();
