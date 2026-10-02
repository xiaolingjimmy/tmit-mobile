/* ==========================================================================
   新手教程（注入式 UI 层，双平台生效）
   --------------------------------------------------------------------------
   设计要点：
   - 只做「引导 + 限制点击」，不改任何游戏数值 / 计时 / 存档语义；
   - 进度判定一律读游戏状态（player.level / hasUpgrade / player.subtabs），
     不看点击次数，玩家中途自己推进也不会卡死；
   - 教程记录写独立 localStorage key，不写进游戏存档 player 对象；
   - 阶段 A（强制引导，≤60 秒）：只允许点高亮目标；找不到目标时不锁屏，
     避免玩家在别的页面被卡住；
   - 阶段 B（自由操作 + 目标条）：直到合成台出现为止，最后给结语。
   ========================================================================== */
(function () {
	'use strict';

	var TUT_KEY = 'tmit_tutorial_v1';
	var POLL_MS = 250;

	// 阶段 B 的判定：木头升级 15「发展科技」解锁制造区域与合成台层级
	var GOAL_UPGRADE = 15;
	var FIRST_UPGRADE = 11; // 「游戏开始」

	var root = null, cardEl = null, titleEl = null, textEl = null;
	var barEl = null, barTextEl = null, ringEl = null, blocks = [];
	var active = false, mode = 'off', stepIndex = 0, targetEl = null, pollTimer = null;
	var opened = []; // 已显示过的弹窗（避免重复）

	// ---------- 工具 ----------
	function en() {
		try { return !geti18n(); } catch (e) { return false; }
	}
	function t(zh, eng) { return en() ? eng : zh; }

	function P() { return window.player || null; }
	function hasUp(layer, id) {
		try { return hasUpgrade(layer, id); } catch (e) { return false; }
	}
	function subtab() {
		var p = P();
		return (p && p.subtabs && p.subtabs.wood) ? String(p.subtabs.wood.stuff || '') : '';
	}
	function levelValue() {
		var p = P();
		try { return p ? Number(p.level.toString()) : 0; } catch (e) { return 0; }
	}
	function woodValue() {
		var p = P();
		try { return p ? Number(p.wood.points.toString()) : 0; } catch (e) { return 0; }
	}
	function craftingTableShown() {
		try { return !!(window.tmp && tmp.crafting_table && tmp.crafting_table.layerShown); } catch (e) { return false; }
	}
	function layerTotal() {
		// 层级总数 = 所有 layer 去掉「其他页面 / 杂项 / 世界分隔」这类非游戏层级
		var exclude = ['info-tab', 'options-tab', 'changelog-tab', 'OtherTab small', 'Setting',
			'Information', 'Changelog', 'blank', 'tree-tab', 'general', '0layer', '1layer', '2layer',
			'w2', 'w3', 'w4', 'w5', 'w6', 'statistics', 'stories', 'layer_select', 'achievements',
			'offline_progress', 'map'];
		try {
			return Object.keys(layers).filter(function (k) { return exclude.indexOf(k) < 0; }).length;
		} catch (e) { return 0; }
	}

	// ---------- 记录读写 ----------
	function readRec() {
		try { return JSON.parse(localStorage.getItem(TUT_KEY) || 'null'); } catch (e) { return null; }
	}
	function writeRec(state, step) {
		try {
			localStorage.setItem(TUT_KEY, JSON.stringify({ v: 1, state: state, step: step || '', t: Date.now() }));
		} catch (e) { /* 忽略 */ }
	}
	function isFinished() {
		var r = readRec();
		return !!(r && (r.state === 'done' || r.state === 'skipped'));
	}

	// ---------- 目标查找 ----------
	function buttons() { return Array.prototype.slice.call(document.querySelectorAll('button')); }
	function findTab(label) {
		var list = Array.prototype.slice.call(document.querySelectorAll('.tabButton'));
		for (var i = 0; i < list.length; i++) {
			if ((list[i].textContent || '').trim() === label) return list[i];
		}
		return null;
	}
	function findByText(needle, scope) {
		var list = Array.prototype.slice.call((scope || document).querySelectorAll('button'));
		for (var i = 0; i < list.length; i++) {
			if ((list[i].textContent || '').indexOf(needle) >= 0) return list[i];
		}
		return null;
	}
	function findUpgradesTab() { return findTab('升级') || findTab('Upgrades'); }
	function findWoodTab() { return findTab('伐木') || findTab('Wood'); }
	function findFirstUpgrade() { return findByText('游戏开始') || findByText('Game Start'); }
	// 移动端 js/mobile.js 的 stripClickPrefix() 会把「点击撸树」改写成「撸树」，
	// 桌面端保持「点击撸树」，这里两种文案都要匹配。
	function findChopButton() { return findByText('撸树') || findByText('Chop'); }
	function findLevelDisplay() {
		return document.getElementById('mobile-statusbar') ||
			document.querySelector('.mobile-statusbar') ||
			document.querySelector('.res') || null;
	}
	function inWoodLayer() {
		var p = P();
		return !!p && String(p.tab) === 'wood';
	}

	// 新号 player.tab 可能是 "none"（内容区空白），教程开始时把玩家带到木头层级，
	// 之后每步仍然只允许点高亮目标。
	function ensureWood() {
		var p = P();
		if (!p) return;
		if (String(p.tab) === 'wood') return;
		try { showTab('wood'); } catch (e) { /* 忽略 */ }
	}

	// ---------- 阶段 A 步骤表 ----------
	var STEPS = [
		{
			id: 'upgTab', target: findUpgradesTab,
			zh: '点「升级」：这里是木头层的升级页',
			eng: 'Tap "升级" — the wood layer upgrades',
			done: function () { return subtab() === 'upgrades'; }
		},
		{
			id: 'buyStart', target: findFirstUpgrade,
			zh: '买下「游戏开始」：花 0 木头，每秒 +1 经验',
			eng: 'Buy "游戏开始" — 0 wood, +1 XP per second',
			done: function () { return hasUp('wood', FIRST_UPGRADE); }
		},
		{
			id: 'level1', target: findLevelDisplay, lock: false,
			zh: '等经验涨到 25，你就会升到 1 级',
			eng: 'Wait for 25 XP — that reaches level 1',
			done: function () { return levelValue() >= 1; }
		},
		{
			id: 'woodTab', target: findWoodTab,
			zh: '回「伐木」页，准备动手',
			eng: 'Back to "伐木" to start chopping',
			done: function () { return subtab() === 'wood'; }
		},
		{
			id: 'chop', target: findChopButton,
			zh: '点「撸树」按钮：进度条满了就得到木头',
			eng: 'Tap the chop button — a full bar gives you wood',
			done: function () { var p = P(); return !!(p && p.wood.destroying); }
		}
	];

	// ---------- DOM ----------
	function build() {
		if (root) return;
		root = document.createElement('div');
		root.id = 'tut-root';
		root.hidden = true;

		for (var i = 0; i < 4; i++) {
			var b = document.createElement('div');
			b.className = 'tut-block';
			root.appendChild(b);
			blocks.push(b);
		}

		ringEl = document.createElement('div');
		ringEl.className = 'tut-ring';
		root.appendChild(ringEl);

		cardEl = document.createElement('div');
		cardEl.className = 'tut-card';
		titleEl = document.createElement('div');
		titleEl.className = 'tut-title';
		textEl = document.createElement('div');
		textEl.className = 'tut-text';
		var actions = document.createElement('div');
		actions.className = 'tut-actions';
		var skipBtn = document.createElement('button');
		skipBtn.type = 'button';
		skipBtn.className = 'tut-btn tut-btn-ghost';
		skipBtn.textContent = t('跳过', 'Skip');
		skipBtn.addEventListener('click', onSkipClick);
		var nextBtn = document.createElement('button');
		nextBtn.type = 'button';
		nextBtn.className = 'tut-btn tut-btn-main';
		nextBtn.id = 'tut-next';
		nextBtn.addEventListener('click', onNextClick);
		actions.appendChild(skipBtn);
		actions.appendChild(nextBtn);
		cardEl.appendChild(titleEl);
		cardEl.appendChild(textEl);
		cardEl.appendChild(actions);
		root.appendChild(cardEl);

		barEl = document.createElement('div');
		barEl.className = 'tut-bar';
		barTextEl = document.createElement('span');
		barTextEl.className = 'tut-bar-text';
		barEl.appendChild(barTextEl);
		root.appendChild(barEl);

		document.body.appendChild(root);
		window.addEventListener('resize', layout);
		window.addEventListener('orientationchange', layout);
		document.addEventListener('scroll', layout, true);
	}

	function setMode(next) {
		mode = next;
		root.hidden = (next === 'off');
		cardEl.style.display = (next === 'a' || next === 'ask' || next === 'end') ? 'block' : 'none';
		barEl.style.display = (next === 'b') ? 'flex' : 'none';
		ringEl.style.display = (next === 'b' || next === 'end') ? 'none' : 'block';
		if (next === 'b' || next === 'end') hideBlockers();
		layout();
	}

	function hideBlockers() {
		for (var i = 0; i < blocks.length; i++) blocks[i].style.display = 'none';
		ringEl.style.display = 'none';
	}

	// 4 块遮罩围出目标矩形（目标本身不被覆盖，保持可点）
	function blockAround(r) {
		var w = window.innerWidth, h = window.innerHeight;
		var pad = 6;
		var x1 = Math.max(0, r.left - pad), y1 = Math.max(0, r.top - pad);
		var x2 = Math.min(w, r.right + pad), y2 = Math.min(h, r.bottom + pad);
		var rects = [
			[0, 0, w, y1],            // 上
			[0, y2, w, h - y2],       // 下
			[0, y1, x1, y2 - y1],     // 左
			[x2, y1, w - x2, y2 - y1] // 右
		];
		for (var i = 0; i < 4; i++) {
			var el = blocks[i], rc = rects[i];
			el.style.display = (rc[2] > 0 && rc[3] > 0) ? 'block' : 'none';
			el.style.left = rc[0] + 'px';
			el.style.top = rc[1] + 'px';
			el.style.width = rc[2] + 'px';
			el.style.height = rc[3] + 'px';
		}
		ringEl.style.display = 'block';
		ringEl.style.left = x1 + 'px';
		ringEl.style.top = y1 + 'px';
		ringEl.style.width = (x2 - x1) + 'px';
		ringEl.style.height = (y2 - y1) + 'px';
	}

	function layout() {
		if (!root || root.hidden) return;
		if (mode !== 'a' || !targetEl || !targetEl.isConnected) {
			if (mode === 'a') hideBlockers();
			return;
		}
		var r = targetEl.getBoundingClientRect();
		if (!r || (r.width === 0 && r.height === 0)) { hideBlockers(); return; }
		blockAround(r);
	}

	function refreshTarget() {
		var step = STEPS[stepIndex];
		targetEl = step && step.target ? step.target() : null;
	}

	// ---------- 文案与按钮 ----------
	function setCard(title, text, nextLabel) {
		titleEl.textContent = title;
		textEl.textContent = text;
		var nextBtn = document.getElementById('tut-next');
		nextBtn.textContent = nextLabel || t('我知道了', 'Got it');
	}

	function showAsk() {
		build();
		setMode('ask');
		hideBlockers();
		cardEl.classList.add('tut-ask');
		setCard(t('新手教程', 'Tutorial'),
			t('第一次玩？跟着点 1 分钟就能上手。', 'New here? One minute of guided taps.'),
			t('开始教程', 'Start'));
		var nextBtn = document.getElementById('tut-next');
		nextBtn.style.display = '';
		root.querySelector('.tut-btn-ghost').textContent = t('暂不', 'Not now');
	}

	function showStep() {
		build();
		ensureWood();
		cardEl.classList.remove('tut-ask');
		setMode('a');
		var step = STEPS[stepIndex];
		var nextBtn = document.getElementById('tut-next');
		nextBtn.style.display = 'none'; // 阶段 A 靠完成状态自动推进
		root.querySelector('.tut-btn-ghost').textContent = t('跳过教程', 'Skip');
		root.querySelector('.tut-btn-ghost').style.display = '';
		var hint = t(step.zh, step.eng);
		if (!inWoodLayer() && stepIndex < 4) {
			hint = t('先回到「木头」层级，再继续：', 'Go back to the wood layer: ') + hint;
		}
		setCard(t('第 ' + (stepIndex + 1) + ' / ' + STEPS.length + ' 步', 'Step ' + (stepIndex + 1) + ' / ' + STEPS.length), hint);
		refreshTarget();
		if (!targetEl) hideBlockers();
		writeRec('running', step.id);
		layout();
	}

	function showHandoff() {
		build();
		setMode('a');
		hideBlockers();
		writeRec('running', 'handoff');
		cardEl.classList.remove('tut-ask');
		root.querySelector('.tut-btn-ghost').style.display = 'none';
		var nextBtn = document.getElementById('tut-next');
		nextBtn.style.display = '';
		setCard(t('基础操作你会了', 'Basics done'),
			t('接下来靠自己：升到 3 级、攒 90 木头，买下「发展科技」，合成台就会出现。',
				'Now on your own: reach level 3, save 90 wood, buy "发展科技" to unlock the crafting table.'),
			t('开始探索', 'Explore'));
	}

	function showGoalBar() {
		build();
		setMode('b');
		writeRec('running', 'goal');
		updateGoalBar();
	}

	function updateGoalBar() {
		if (!barTextEl) return;
		var lv = levelValue(), wd = woodValue();
		var lvTxt = (lv > 3 ? 3 : lv) + '/3';
		var wdTxt = (wd > 90 ? 90 : Math.floor(wd)) + '/90';
		barTextEl.textContent = t(
			'新手目标：等级 ' + lvTxt + ' · 木头 ' + wdTxt + ' → 买「发展科技」解锁合成台',
			'Goal: level ' + lvTxt + ' · wood ' + wdTxt + ' → buy "发展科技" for the crafting table');
	}

	function showEnd() {
		build();
		setMode('end');
		var n = layerTotal();
		var nextBtn = document.getElementById('tut-next');
		nextBtn.style.display = '';
		root.querySelector('.tut-btn-ghost').style.display = 'none';
		cardEl.classList.remove('tut-ask');
		setCard(t('教程完成', 'Tutorial complete'),
			t('🎉 恭喜你已经会玩这个游戏了，接下来去探索游戏的 ' + n + ' 个层级吧！\n合成台小提示：木斧（120 木头，撸树速度 ×2.5）、木镐（3 合成台 + 500 木头，解锁挖石头）。',
				'🎉 You know how to play now — go explore all ' + n + ' layers!\nCrafting table: Wooden Axe (120 wood, woodcutting ×2.5), Wooden Pickaxe (3 tables + 500 wood, unlocks stone mining).'),
			t('太棒了', 'Nice'));
	}

	// ---------- 交互 ----------
	function onNextClick() {
		if (mode === 'ask') { startFresh(); return; }
		if (mode === 'a' && stepIndex >= STEPS.length) { // handoff 卡
			showGoalBar();
			return;
		}
		if (mode === 'end') { finish('done'); }
	}

	function onSkipClick() {
		if (mode === 'ask') { finish('skipped'); return; }
		var ok = true;
		try { ok = confirm(t('确定跳过新手教程吗？之后可在设置页重看。', 'Skip the tutorial? You can replay it from Settings.')); } catch (e) { ok = true; }
		if (ok) finish('skipped');
	}

	function finish(state) {
		writeRec(state, '');
		active = false;
		if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
		setMode('off');
	}

	function startFresh() {
		active = true;
		stepIndex = 0;
		showStep();
		if (!pollTimer) pollTimer = setInterval(tick, POLL_MS);
	}

	function tick() {
		if (!active) return;
		if (mode === 'b') {
			updateGoalBar();
			if (craftingTableShown() || hasUp('wood', GOAL_UPGRADE)) { showEnd(); active = true; mode = 'end'; return; }
			return;
		}
		if (mode !== 'a') return;
		if (stepIndex >= STEPS.length) return;
		var step = STEPS[stepIndex];
		if (step.done && step.done()) {
			stepIndex++;
			if (stepIndex >= STEPS.length) { showHandoff(); return; }
			showStep();
			return;
		}
		// 目标可能后出现（例如 Vue 重渲染），保持跟随
		refreshTarget();
		layout();
	}

	// ---------- 对外 API ----------
	function start(force) {
		if (!P()) return false;
		build();
		if (force) { startFresh(); return true; }
		if (isFinished()) return false;
		showAsk();
		return true;
	}

	function reset() {
		writeRec('new', '');
		start(true);
	}

	// 断点续跑：刷新 / 关页面后，若记录为 running 就回到那一步继续
	function resumeFrom(rec) {
		if (rec.step === 'goal') {          // 阶段 B：目标条
			active = true;
			showGoalBar();
			if (!pollTimer) pollTimer = setInterval(tick, POLL_MS);
			return;
		}
		if (rec.step === 'handoff') {       // 阶段 A 收尾卡
			active = true;
			stepIndex = STEPS.length;
			showHandoff();
			if (!pollTimer) pollTimer = setInterval(tick, POLL_MS);
			return;
		}
		var idx = 0;
		for (var i = 0; i < STEPS.length; i++) {
			if (STEPS[i].id === rec.step) { idx = i; break; }
		}
		active = true;
		stepIndex = idx;
		showStep();
		if (!pollTimer) pollTimer = setInterval(tick, POLL_MS);
	}

	// 首次进入自动询问：仅新号（等级 0、无木头、未买第一个升级）且没有教程记录
	function maybeAutoStart() {
		var p = P();
		if (!p) return;
		var rec = readRec();
		if (rec) {
			if (rec.state === 'running') resumeFrom(rec);
			return;
		}
		if (levelValue() > 0 || woodValue() > 0 || hasUp('wood', FIRST_UPGRADE)) {
			writeRec('done', ''); // 老玩家：静默标记，不打扰
			return;
		}
		showAsk();
	}

	window.Tutorial = {
		start: start,
		reset: reset,
		isFinished: isFinished,
		state: function () { return readRec(); }
	};

	function boot() {
		if (window.player) { maybeAutoStart(); return; }
		var tries = 0;
		var timer = setInterval(function () {
			tries++;
			if (window.player) { clearInterval(timer); maybeAutoStart(); }
			else if (tries > 200) { clearInterval(timer); }
		}, 50);
	}

	if (document.readyState === 'complete') {
		setTimeout(boot, 0);
	} else {
		window.addEventListener('load', function () { setTimeout(boot, 0); });
	}
})();
