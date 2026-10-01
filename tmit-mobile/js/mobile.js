// ==========================================================================
// 挖矿增量页 (TMIT) — 移动端原生 UI 脚本
// --------------------------------------------------------------------------
// 本文件为 1:1 移植的移动端界面层，只负责移动端 / 触屏适配与界面注入，
// 不改动任何游戏逻辑：
//   1. 检测触屏 / 移动端，给 <body> 加 .is-mobile；
//   2. 注入顶部状态栏（经验 / 等级 / 离线时间 + 返回按钮）与底部导航栏
//      （4 项：层级 / 成就 / 跃迁 / 设置）；
//   3. 同步 touch 坐标到 updateMouse（供粒子系统使用）；
//   4. tap 切换 .tooltipBox.tooltip-show 显示 tooltip（不干扰购买）；
//   5. 监听 player.tab / player.navTab 变化，维护 .mobile-content-open /
//      .mobile-tab-options 状态并高亮底部导航当前项；
//   6. 设置页注入快捷入口面板（统计 / 故事 / 地图 / 层级选择 / 信息 / 更新日志）；
//   7. 层级树折叠：为含可见层级的行注入可折叠表头，折叠被隐藏节点不画连线；
//   8. resize / orientationchange 时重绘树连线并刷新 --tabWidth；
//   9. 设置页注入性能控制面板（MSPT 实时读数 + 更新频率预设，替代游戏的 prompt 入口）。
// 所有逻辑都在游戏 load() 完成、window.player 就绪之后执行。
// ==========================================================================
(function () {
	'use strict';

	// ---------- 触屏 / 移动端检测 ----------
	function detectMobile() {
		return (
			('ontouchstart' in window) ||
			(navigator.maxTouchPoints > 0) ||
			(window.innerWidth <= 768)
		);
	}

	// ---------- 从 touch 事件中取出首个触点 ----------
	function getTouch(event) {
		if (event && event.touches && event.touches.length > 0) return event.touches[0];
		if (event && event.changedTouches && event.changedTouches.length > 0) return event.changedTouches[0];
		return null;
	}

	// 供 index.html 的 <body ontouchstart/ontouchmove> 调用，避免与 onmousemove 冲突
	window.updateMouseTouch = function (event) {
		var t = getTouch(event);
		if (t && typeof window.updateMouse === 'function') {
			window.updateMouse({ clientX: t.clientX, clientY: t.clientY });
		}
	};

	// ---------- tooltip 触屏兜底（事件委托） ----------
	// 只负责显示 / 隐藏 tooltip，不阻止默认行为，因此按钮的购买 / 点击照常触发。
	function clearTooltips(except) {
		var els = document.querySelectorAll('.tooltipBox.tooltip-show');
		for (var i = 0; i < els.length; i++) {
			if (els[i] !== except) els[i].classList.remove('tooltip-show');
		}
	}

	function onTouchStartForTooltip(event) {
		var target = event.target;
		if (!target || typeof target.closest !== 'function') return;
		var box = target.closest('.tooltipBox');
		if (box) {
			var wasShown = box.classList.contains('tooltip-show');
			clearTooltips(box);
			box.classList.toggle('tooltip-show', !wasShown);
		} else {
			clearTooltips(null);
		}
	}

	// ---------- 注入 DOM：顶部状态栏 + 底部导航栏 ----------
	var statusbar = null;
	var backButton = null;
	var navbar = null;
	var quicknav = null;
	var treeObserver = null;
	var navItems = {};
	var statExp = null;
	var statLevel = null;
	var statOffline = null;
	var lastContentOpen = false;
	// 折叠状态签名：仅当折叠状态变化时才重绘树连线，避免稳态下无谓重绘
	var lastCollapseSignature = null;

	function buildStatusbar() {
		var bar = document.createElement('div');
		bar.className = 'mobile-statusbar';

		backButton = document.createElement('button');
		backButton.type = 'button';
		backButton.className = 'mobile-back';
		backButton.setAttribute('aria-label', '返回');
		backButton.textContent = '←';
		backButton.addEventListener('click', function () {
			if (typeof window.goBack === 'function' && window.player) {
				window.goBack(window.player.tab);
			}
		});

		var stats = document.createElement('div');
		stats.className = 'msb-stats';

		statExp = document.createElement('span');
		statExp.className = 'msb-exp';
		statLevel = document.createElement('span');
		statLevel.className = 'msb-lv';
		statOffline = document.createElement('span');
		statOffline.className = 'msb-off';

		stats.appendChild(statExp);
		stats.appendChild(statLevel);
		stats.appendChild(statOffline);

		bar.appendChild(backButton);
		bar.appendChild(stats);
		return bar;
	}

	// ---------- 内联 SVG 图标 ----------
	// 采用 Feather Icons（MIT，24x24 线性图标）内联源码，不新增文件、不引外链。
	// 统一用 currentColor 描边，使底部导航的激活 / 非激活配色能自动作用到图标。
	function svgIcon(inner) {
		return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" ' +
			'stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ' +
			'stroke-linejoin="round" aria-hidden="true" focusable="false">' + inner + '</svg>';
	}

	var ICONS = {
		// 底部导航
		layers: svgIcon('<polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline>'),
		award: svgIcon('<circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline>'),
		clock: svgIcon('<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>'),
		settings: svgIcon('<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>'),
		// 设置页快捷入口
		barChart: svgIcon('<line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line>'),
		bookOpen: svgIcon('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>'),
		map: svgIcon('<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon><line x1="8" y1="2" x2="8" y2="18"></line><line x1="16" y1="6" x2="16" y2="22"></line>'),
		grid: svgIcon('<rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect>'),
		info: svgIcon('<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line>'),
		fileText: svgIcon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline>')
	};

	// 创建图标容器 span，并把内联 SVG 作为其子元素插入
	function makeIcon(className, svg) {
		var span = document.createElement('span');
		span.className = className;
		span.innerHTML = svg || '';
		return span;
	}

	function buildNavbar() {
		var nav = document.createElement('nav');
		nav.className = 'mobile-navbar';

		var items = [
			{ key: 'tree', icon: 'layers', label: '层级' },
			{ key: 'achievements', icon: 'award', label: '成就' },
			{ key: 'timewarp', icon: 'clock', label: '跃迁' },
			{ key: 'settings', icon: 'settings', label: '设置' }
		];

		items.forEach(function (it) {
			var btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'mnav-item';
			btn.setAttribute('data-nav', it.key);
			var icon = makeIcon('mnav-icon', ICONS[it.icon]);
			var label = document.createElement('span');
			label.className = 'mnav-label';
			label.textContent = it.label;
			btn.appendChild(icon);
			btn.appendChild(label);
			btn.addEventListener('click', function () {
				navigate(it.key);
			});
			navItems[it.key] = btn;
			nav.appendChild(btn);
		});

		return nav;
	}

	// ---------- 底部导航动作 ----------
	function navigate(name) {
		if (!window.player) return;
		switch (name) {
			case 'tree':
				if (typeof window.showNavTab === 'function') window.showNavTab('tree-tab');
				if (typeof window.showTab === 'function') window.showTab('none');
				break;
			case 'achievements':
				if (typeof window.showNavTab === 'function') window.showNavTab('tree-tab');
				if (typeof window.showTab === 'function') window.showTab('achievements');
				break;
			case 'timewarp':
				if (typeof window.showNavTab === 'function') window.showNavTab('tree-tab');
				if (typeof window.showTab === 'function') window.showTab('offline_progress');
				break;
			case 'settings':
				if (typeof window.showNavTab === 'function') window.showNavTab('tree-tab');
				if (typeof window.showTab === 'function') window.showTab('options-tab');
				break;
		}
		setTimeout(syncContentState, 0);
	}

	// ---------- 层级内容面板是否打开 ----------
	// 与 index.html 中 .col2 的 v-if 条件保持一致
	function isContentOpen() {
		var p = window.player;
		if (!p) return false;
		if (typeof p.tab !== 'string' || typeof p.navTab !== 'string') return false;
		return p.navTab !== 'none' && p.tab !== 'none' && p.tab !== 'tree-tab';
	}

	// 归入「设置」导航项的页签集合（这些页签打开时高亮底部导航的「设置」）
	var SETTINGS_PAGES = ['options-tab', 'statistics', 'stories', 'map', 'layer_select', 'info-tab', 'changelog-tab'];

	function updateNavActive() {
		var p = window.player;
		var active = '';
		if (!p) active = '';
		else if (p.tab === 'none') active = 'tree';
		else if (p.tab === 'achievements') active = 'achievements';
		else if (p.tab === 'offline_progress') active = 'timewarp';
		else if (SETTINGS_PAGES.indexOf(p.tab) >= 0) active = 'settings';
		for (var k in navItems) {
			if (navItems[k]) navItems[k].classList.toggle('active', k === active);
		}
	}

	function syncContentState() {
		var open = isContentOpen();
		document.body.classList.toggle('mobile-content-open', open);
		// 处于设置页时显示设置快捷入口面板（由 CSS 控制显隐）
		var onOptions = !!(window.player && window.player.tab === 'options-tab');
		document.body.classList.toggle('mobile-tab-options', onOptions);
		// 性能面板与快捷入口共用同一开关（兜底：样式未就绪时也不会在非设置页误显）
		if (perfPanel) perfPanel.hidden = !onOptions;
		updateNavActive();
		// 每次状态同步都兜底维护折叠表头（幂等）
		enhanceTree();
		// 兜底剥离点击按钮文案的「点击」前缀（幂等，摊销 O(1)）
		stripClickPrefix();
		// 兜底隐藏游戏自带的 prompt 版更新频率按钮（幂等）
		hideNativeUpdatingRate();
		if (open !== lastContentOpen) {
			lastContentOpen = open;
			// 树面板显示 / 隐藏切换后重绘树形连线
			safeResizeCanvas();
		}
	}

	// ---------- 设置页快捷入口面板 ----------
	// 点击后把目标页签的 prevTab 设为设置页，使顶部返回键 goBack 可回到设置页
	function openSettingsSub(target) {
		if (!window.player) return;
		try {
			if (window.player[target]) window.player[target].prevTab = 'options-tab';
		} catch (e) { /* 忽略 */ }
		if (typeof window.showTab === 'function') window.showTab(target);
		setTimeout(syncContentState, 0);
	}

	function buildQuicknav() {
		var panel = document.createElement('div');
		panel.id = 'mobile-quicknav';
		panel.className = 'mobile-quicknav';

		var defs = [
			{ target: 'statistics', icon: 'barChart', label: '统计' },
			{ target: 'stories', icon: 'bookOpen', label: '故事' },
			{ target: 'map', icon: 'map', label: '地图' },
			{ target: 'layer_select', icon: 'grid', label: '层级选择' },
			{ target: 'info-tab', icon: 'info', label: '信息' },
			{ target: 'changelog-tab', icon: 'fileText', label: '更新日志' }
		];

		defs.forEach(function (d) {
			var btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'mq-item';
			btn.setAttribute('data-target', d.target);
			var ic = makeIcon('mq-icon', ICONS[d.icon]);
			btn.appendChild(ic);
			btn.appendChild(document.createTextNode(d.label));
			btn.addEventListener('click', function () { openSettingsSub(d.target); });
			panel.appendChild(btn);
		});

		return panel;
	}

	// ---------- 移动端性能控制面板 ----------
	// 只读游戏自带的性能数据（pastTickTimes / options.updatingRate），把「更新频率」
	// 做成正经的移动端控件：游戏原入口是 prompt() 弹窗，手机上体验差、PWA 独立模式
	// 下还可能被禁用。不修改任何游戏文件，也不改 updatingRate 的默认值——只在玩家
	// 点击预设时改变（与游戏 setUpdatingRate() 等价：改 options + 重启主循环）。
	var perfPanel = null;
	var perfMspt = null;
	var perfRate = null;
	var perfHint = null;
	var perfButtons = [];
	var PERF_RATES = [50, 100, 200, 500];

	// 读取当前更新频率（options 由 options.js 用 let 声明，须以裸标识符访问）
	function getUpdatingRate() {
		try {
			if (typeof options !== 'undefined' && options && typeof options.updatingRate === 'number') {
				return options.updatingRate;
			}
		} catch (err) { /* 忽略 */ }
		return null;
	}

	// 计算 MSPT：pastTickTimes 最近 10 次 tick 的毫秒耗时平均值（空数组返回 null）
	function getMspt() {
		var t = (typeof pastTickTimes !== 'undefined') ? pastTickTimes : null;
		if (!t || typeof t.length !== 'number' || t.length === 0) return null;
		var sum = 0, n = 0;
		for (var i = 0; i < t.length; i++) {
			var v = Number(t[i]);
			if (isFinite(v)) { sum += v; n++; }
		}
		return n > 0 ? (sum / n) : null;
	}

	function updatePerfActive(rate) {
		for (var i = 0; i < perfButtons.length; i++) {
			var b = perfButtons[i];
			b.classList.toggle('active', Number(b.getAttribute('data-rate')) === rate);
		}
	}

	// 与游戏 setUpdatingRate() 等价：改 options.updatingRate 后必须重启主循环才生效
	function applyUpdatingRate(rate) {
		try {
			if (typeof options === 'undefined' || !options) return;
			options.updatingRate = rate;
		} catch (err) { return; }
		if (typeof window.startInterval === 'function') {
			try { window.startInterval(); } catch (err) { /* 忽略 */ }
		}
		updatePerfPanel();
	}

	// 刷新读数；只在设置页可见时计算，DOM 仅在文本真正变化时才写
	function updatePerfPanel() {
		if (!perfPanel) return;
		if (!document.body.classList.contains('mobile-tab-options')) return;

		var mspt = getMspt();
		var rate = getUpdatingRate();

		var msptText = (mspt === null) ? 'MSPT --' : ('MSPT ' + mspt.toFixed(1) + 'ms');
		var rateText = (rate === null) ? '更新频率 --ms' : ('更新频率 ' + rate + 'ms');
		if (perfMspt && perfMspt.textContent !== msptText) perfMspt.textContent = msptText;
		if (perfRate && perfRate.textContent !== rateText) perfRate.textContent = rateText;

		// 严格按游戏自身判定：mspt > updatingRate 即「跟不上」
		var warn = (mspt !== null && rate !== null && mspt > rate);
		if (perfPanel.classList.contains('mp-warn') !== warn) perfPanel.classList.toggle('mp-warn', warn);

		var hint = '';
		if (warn) {
			// 面板提示行是单行省略（.mp-hint），故文案需在 390px 内不溢出，
			// 且必须保留「产量不减」这一玩家最关心的信息。
			hint = '每帧 ' + mspt.toFixed(1) + 'ms 超过 ' + rate + 'ms，建议调高更新频率（产量不减）';
		} else if (mspt !== null && rate !== null) {
			hint = '运行流畅：每帧 ' + mspt.toFixed(1) + 'ms ≤ 设定频率 ' + rate + 'ms';
		}
		if (perfHint && perfHint.textContent !== hint) perfHint.textContent = hint;

		updatePerfActive(rate);
	}

	// 隐藏游戏自带的 prompt 版「更新频率」按钮（避免两个入口打架）。
	// 幂等：dataset.mpHidden 标记；元素被 Vue 重建后会自动重新隐藏。找不到就静默跳过。
	function hideNativeUpdatingRate() {
		if (!document.body.classList.contains('mobile-tab-options')) return;
		var btns = document.querySelectorAll('button.opt');
		for (var i = 0; i < btns.length; i++) {
			var b = btns[i];
			if (b.dataset && b.dataset.mpHidden === '1') continue;
			var txt = (b.textContent || '').trim();
			if (txt.indexOf('更新频率') !== 0) continue;
			var oc = b.getAttribute('onclick') || '';
			if (oc.indexOf('setUpdatingRate') < 0) continue;
			try {
				b.style.display = 'none';
				if (b.dataset) b.dataset.mpHidden = '1';
			} catch (err) { /* 忽略 */ }
		}
	}

	function buildPerfPanel() {
		perfButtons = [];

		var panel = document.createElement('div');
		panel.id = 'mobile-perf';
		panel.className = 'mobile-perf';
		// 默认隐藏；由 syncContentState 按 body.mobile-tab-options 同步（兜底，
		// 即使样式尚未就绪也不会在非设置页误显）
		panel.hidden = true;

		var head = document.createElement('div');
		head.className = 'mp-head';

		var title = document.createElement('span');
		title.className = 'mp-title';
		title.textContent = '性能';

		perfMspt = document.createElement('span');
		perfMspt.className = 'mp-mspt';
		perfMspt.textContent = 'MSPT --';

		perfRate = document.createElement('span');
		perfRate.className = 'mp-rate';
		perfRate.textContent = '更新频率 --ms';

		head.appendChild(title);
		head.appendChild(perfMspt);
		head.appendChild(perfRate);

		var presets = document.createElement('div');
		presets.className = 'mp-presets';
		for (var i = 0; i < PERF_RATES.length; i++) {
			(function (r) {
				var btn = document.createElement('button');
				btn.type = 'button';
				btn.className = 'mp-btn';
				btn.setAttribute('data-rate', String(r));
				btn.textContent = String(r);
				btn.addEventListener('click', function () { applyUpdatingRate(r); });
				perfButtons.push(btn);
				presets.appendChild(btn);
			})(PERF_RATES[i]);
		}

		perfHint = document.createElement('div');
		perfHint.className = 'mp-hint';

		panel.appendChild(head);
		panel.appendChild(presets);
		panel.appendChild(perfHint);

		return panel;
	}

	// ---------- 去掉点击按钮文案的「点击」前缀 ----------
	// 游戏在 js/components.js:360 直接读 layers[L].clickables[k].display 渲染按钮文本，
	// 因此在这里包一层即可改写文案，无需改动任何游戏文件。
	// 「点击撸树」→「撸树」、「点击挖掘」→「挖掘」、「点击寻找」→「寻找」。
	// 幂等：通过 __mNoClickPrefix 标记避免重复包装；只剥离字符串开头的「点击」，
	// 文案中间 / 非开头的「点击」不受影响。
	function stripClickPrefix() {
		if (typeof layers !== 'object' || layers === null) return;
		for (var L in layers) {
			var cl = layers[L] && layers[L].clickables;
			if (!cl) continue;
			for (var k in cl) {
				var c = cl[k];
				if (!c || typeof c.display !== 'function' || c.display.__mNoClickPrefix) continue;
				c.display = (function (orig) {
					var wrapped = function () {
						var v = orig.apply(this, arguments);
						return typeof v === 'string' ? v.replace(/^点击/, '') : v;
					};
					wrapped.__mNoClickPrefix = true;
					return wrapped;
				})(c.display);
			}
		}
	}

	// ---------- 层级树折叠 ----------
	// 已迁移到导航栏 / 设置页、或作为分组表头的节点，不参与「可见内容卡片」计数
	var MIGRATED_LAYERS = [
		'Setting', 'Information', 'Changelog', 'statistics', 'stories', 'map', 'layer_select',
		'achievements', 'offline_progress', 'OtherTab small', '0layer', '1layer',
		'w2', 'w3', 'w4', 'w5', 'w6', '2layer', 'energy'
	];
	// 折叠状态（按行下标存储），挂在 window 上以便跨次重建保持
	window.MOBILE_TREE_COLLAPSED = window.MOBILE_TREE_COLLAPSED || {};

	// 取行的直接子元素中的折叠表头（不依赖 :scope 选择器）
	function getTreeHead(row) {
		var kids = row.children;
		for (var i = 0; i < kids.length; i++) {
			if (kids[i].classList && kids[i].classList.contains('m-tree-head')) return kids[i];
		}
		return null;
	}

	// ---------- 重绘就绪守卫 ----------
	// tmp 尚未由 setupTemp() / updateTemp() 填充时，resizeCanvas → drawTree 会读
	// tmp[layer].layerShown 抛错。移动端自身触发的重绘同样要等 tmp 就绪。
	function treeTmpReady() {
		if (typeof tmp !== 'object' || tmp === null) return false;
		if (typeof layers !== 'object' || layers === null) return false;
		for (var k in layers) { if (!tmp[k]) return false; }
		return true;
	}

	function safeResizeCanvas() {
		if (!treeTmpReady()) return;
		if (typeof window.resizeCanvas === 'function') {
			try { window.resizeCanvas(); } catch (err) { /* 忽略 */ }
		}
	}

	// 按折叠状态切换行的 m-collapsed 类 / aria / 箭头
	function applyTreeCollapse() {
		var treeTab = document.getElementById('treeTab');
		if (!treeTab) return;
		var rows = treeTab.querySelectorAll('.upgRow');
		var signature = '';
		for (var i = 0; i < rows.length; i++) {
			var row = rows[i];
			var head = getTreeHead(row);
			if (!head) { signature += '-'; continue; }
			var collapsed = !!window.MOBILE_TREE_COLLAPSED[i];
			row.classList.toggle('m-collapsed', collapsed);
			head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
			var arrow = head.querySelector('.m-tree-arrow');
			if (arrow) {
				var t = collapsed ? '▸' : '▾';
				if (arrow.textContent !== t) arrow.textContent = t;
			}
			signature += collapsed ? '1' : '0';
		}
		// 仅当折叠状态发生变化时才重绘树连线（稳态下不再产生无谓重绘）
		if (signature !== lastCollapseSignature) {
			lastCollapseSignature = signature;
			safeResizeCanvas();
		}
	}

	// 为含可见层级的行注入 / 更新折叠表头（幂等：已存在只更新文本）
	function enhanceTree() {
		var treeTab = document.getElementById('treeTab');
		if (!treeTab) return;
		var rows = treeTab.querySelectorAll('.upgRow');

		for (var i = 0; i < rows.length; i++) {
			var row = rows[i];
			var btns = row.querySelectorAll('button.treeNode');
			var contentCount = 0;
			var lastSepLabel = '';

			for (var j = 0; j < btns.length; j++) {
				var b = btns[j];
				var id = b.id || '';
				var txt = (b.textContent || '').trim();
				// 含 ↓ 的记为分组表头节点，取其去符号后的文本作为候选标签
				// 只去掉箭头符号并 trim 首尾，保留中间空格：↓ 世界 1 ↓ → 世界 1
				if (txt.indexOf('↓') >= 0) {
					var lbl = txt.replace(/↓/g, '').trim();
					if (lbl) lastSepLabel = lbl;
				}
				// 不在迁移名单里的才是可见内容卡片
				if (MIGRATED_LAYERS.indexOf(id) < 0) contentCount++;
			}

			var head = getTreeHead(row);

			if (contentCount === 0) {
				// 没有可见内容 → 移除表头、清除折叠
				if (head && head.parentNode) head.parentNode.removeChild(head);
				row.classList.remove('m-collapsed');
				continue;
			}

			if (!head) {
				head = document.createElement('button');
				head.type = 'button';
				head.className = 'm-tree-head';
				head.setAttribute('data-row', String(i));
				head.setAttribute('aria-expanded', 'true');

				var arrow = document.createElement('span');
				arrow.className = 'm-tree-arrow';
				arrow.textContent = '▾';
				var label = document.createElement('span');
				label.className = 'm-tree-label';
				var count = document.createElement('span');
				count.className = 'm-tree-count';

				head.appendChild(arrow);
				head.appendChild(label);
				head.appendChild(count);

				// 用闭包捕获行下标，避免重复绑定（已存在时不会重建）
				(function (rowIndex) {
					head.addEventListener('click', function (e) {
						e.preventDefault();
						e.stopPropagation();
						window.MOBILE_TREE_COLLAPSED[rowIndex] = !window.MOBILE_TREE_COLLAPSED[rowIndex];
						applyTreeCollapse();
					});
				})(i);

				row.insertBefore(head, row.firstChild);
			}

			// 仅在文本变化时写入，避免触发 MutationObserver 死循环
			var labelEl = head.querySelector('.m-tree-label');
			var countEl = head.querySelector('.m-tree-count');
			var wantLabel = lastSepLabel || ('第 ' + (i + 1) + ' 组');
			var wantCount = contentCount + ' 层';
			if (labelEl && labelEl.textContent !== wantLabel) labelEl.textContent = wantLabel;
			if (countEl && countEl.textContent !== wantCount) countEl.textContent = wantCount;
		}

		applyTreeCollapse();
	}

	// 监听 #treeTab 结构变化（新解锁层级出现时立即补折叠表头），debounce 80ms
	function observeTree() {
		var treeTab = document.getElementById('treeTab');
		if (!treeTab || typeof MutationObserver !== 'function') return;
		if (treeObserver) treeObserver.disconnect();
		var debounceTimer = null;
		treeObserver = new MutationObserver(function () {
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(function () { enhanceTree(); }, 80);
		});
		treeObserver.observe(treeTab, { childList: true, subtree: true });
	}

	// ---------- 折叠后画线保护 ----------
	// canvas.js 的 drawTreeBranch 用 getBoundingClientRect 取节点位置；
	// 被折叠隐藏的节点 rect 全 0，会画出飞向原点的错误连线，这里包装跳过（不改 canvas.js）
	function patchTreeCanvas() {
		if (typeof window.drawTreeBranch !== 'function' || window.drawTreeBranch.__mPatched) return;
		var orig = window.drawTreeBranch;
		var wrapped = function (num1, data, prefix) {
			var num2 = Array.isArray(data) ? data[0] : data;
			var id1 = prefix ? prefix + num1 : num1;
			var id2 = prefix ? prefix + num2 : num2;
			var e1 = document.getElementById(id1), e2 = document.getElementById(id2);
			if (!e1 || !e2) return;
			var r1 = e1.getBoundingClientRect(), r2 = e2.getBoundingClientRect();
			if ((!r1.width && !r1.height) || (!r2.width && !r2.height)) return;
			return orig.apply(this, arguments);
		};
		wrapped.__mPatched = true;
		window.drawTreeBranch = wrapped;
	}

	// ---------- 顶部状态栏数据刷新（读取实时数值，只读不改） ----------
	function updateStatusbar() {
		var p = window.player;
		if (!p) return;
		try {
			if (statExp && typeof window.format === 'function') {
				statExp.textContent = '经验 ' + window.format(p.points);
			}
			if (statLevel && typeof window.formatWhole === 'function') {
				statLevel.textContent = '等级 ' + window.formatWhole(p.level);
			}
			if (statOffline && p.offTime && typeof window.formatTime === 'function') {
				statOffline.textContent = '离线 ' + window.formatTime(p.offTime.remain * 1000);
			}
		} catch (err) { /* 忽略格式化异常，避免影响游戏 */ }
	}

	// ---------- 尺寸变化处理 ----------
	function onResize() {
		safeResizeCanvas();
		if (typeof window.updateWidth === 'function') {
			try { window.updateWidth(); } catch (err) { /* 忽略 */ }
		}
	}

	// ---------- 初始化 ----------
	function init() {
		document.body.classList.add('is-mobile');

		statusbar = buildStatusbar();
		navbar = buildNavbar();
		quicknav = buildQuicknav();
		perfPanel = buildPerfPanel();
		document.body.appendChild(statusbar);
		document.body.appendChild(navbar);
		document.body.appendChild(quicknav);
		document.body.appendChild(perfPanel);

		// 包装树连线绘制，跳过被折叠隐藏的节点
		patchTreeCanvas();

		document.addEventListener('touchstart', onTouchStartForTooltip, { passive: true });

		// 用户交互后立即同步导航状态（Vue 重渲染后），另有慢速轮询兜底
		document.addEventListener('click', function () { setTimeout(syncContentState, 0); });
		document.addEventListener('touchend', function () { setTimeout(syncContentState, 0); });
		setInterval(syncContentState, 400);
		setInterval(updateStatusbar, 250);
		// 性能面板读数用独立 500ms 定时器（不塞进 400ms 的 syncContentState）
		setInterval(updatePerfPanel, 500);

		// 树结构变化时立即补折叠表头
		observeTree();

		window.addEventListener('resize', onResize);
		window.addEventListener('orientationchange', onResize);

		syncContentState();
		updateStatusbar();
		updatePerfPanel();
		onResize();
	}

	// 等待游戏 load() 完成（window.player 就绪）后再初始化，避免同步时机报错
	function waitForGame() {
		if (window.player) {
			init();
			return;
		}
		var tries = 0;
		var timer = setInterval(function () {
			tries++;
			if (window.player) {
				clearInterval(timer);
				init();
			} else if (tries > 120) { // 约 6 秒超时
				clearInterval(timer);
			}
		}, 50);
	}

	// 仅移动端初始化；桌面端（无触屏且宽屏）不注入任何东西
	if (!detectMobile()) return;

	if (document.readyState === 'complete') {
		waitForGame();
	} else {
		window.addEventListener('load', function () {
			// body 的 onload="load()" 会先于本监听器执行，这里再延一拍确保其完成
			setTimeout(waitForGame, 0);
		});
	}
})();
