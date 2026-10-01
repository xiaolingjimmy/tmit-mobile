// ==========================================================================
// 挖矿增量页 (TMIT) — 移动端 Service Worker
// --------------------------------------------------------------------------
// 用途：把游戏做成可「添加到主屏幕」并离线游玩的 PWA。
// 策略：
//   1. 安装时预缓存入口（index.html / manifest / 图标），立即接管；
//   2. 同源 GET 请求走 stale-while-revalidate：有缓存先返回缓存，
//      同时后台拉新并写回；断网时退回缓存；
//   3. 跨域资源（如 Google Fonts）不缓存、直连，失败时由页面自行降级。
// 注意：每次发布会换新域名（新 origin），缓存按 origin 隔离，天然不会串版本。
// ==========================================================================
'use strict';

var CACHE_NAME = 'tmit-mobile-v1';

var PRECACHE = [
	'./',
	'./index.html',
	'./manifest.webmanifest',
	'./resources/game_icon.png'
];

self.addEventListener('install', function (event) {
	event.waitUntil(
		caches.open(CACHE_NAME).then(function (cache) {
			return cache.addAll(PRECACHE);
		}).then(function () {
			return self.skipWaiting();
		})
	);
});

self.addEventListener('activate', function (event) {
	event.waitUntil(
		caches.keys().then(function (keys) {
			return Promise.all(keys.filter(function (k) {
				return k !== CACHE_NAME;
			}).map(function (k) {
				return caches.delete(k);
			}));
		}).then(function () {
			return self.clients.claim();
		})
	);
});

self.addEventListener('fetch', function (event) {
	var request = event.request;

	var url;
	try {
		url = new URL(request.url);
	} catch (e) {
		return;
	}

	// API 请求强制走网络，不缓存（避免存档数据被旧缓存覆盖）
	if (url.origin === self.location.origin && url.pathname.indexOf('/api/') === 0) {
		event.respondWith(fetch(request));
		return;
	}

	if (request.method !== 'GET') return;

	// 只处理同源资源；跨域（Google Fonts 等）交还浏览器，失败自然降级
	if (url.origin !== self.location.origin) return;

	event.respondWith(
		caches.match(request).then(function (cached) {
			var network = fetch(request).then(function (response) {
				if (response && response.status === 200 && response.type === 'basic') {
					var clone = response.clone();
					caches.open(CACHE_NAME).then(function (cache) {
						cache.put(request, clone);
					});
				}
				return response;
			}).catch(function () {
				return cached;
			});
			return cached || network;
		})
	);
});
