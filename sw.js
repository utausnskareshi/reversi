/**
 * Service Worker - オフラインキャッシュ（PWA対応）
 *
 * 概要:
 *   Progressive Web App（PWA）としてオフライン動作を実現するためのService Worker。
 *   ゲームに必要なファイルをインストール時にキャッシュし、
 *   以降のリクエストはキャッシュから応答する（Cache-First戦略）。
 *
 * Service Workerのライフサイクル:
 *   install  → キャッシュにファイルを追加
 *   activate → 古いキャッシュを削除
 *   fetch    → リクエストをキャッシュから応答（なければネットワークへ）
 *
 * キャッシュの更新方法:
 *   CACHE_NAME のバージョン番号を変更すると、次回アクセス時に新しいキャッシュが作られ、
 *   古いキャッシュはactivateイベントで自動削除される。
 */

/** キャッシュ名（バージョン管理に使用: 更新時はバージョン番号を上げる） */
const CACHE_NAME = 'reversi-v1';

/**
 * キャッシュするファイルのリスト
 * ゲームの動作に必要な全ファイルを列挙する。
 * 一つでも取得に失敗するとinstallイベントが失敗するため、
 * 実際に存在するファイルのみ記載すること。
 */
const ASSETS = [
  './',             // index.htmlへのリダイレクト
  './index.html',   // メインページ
  './style.css',    // スタイルシート
  './game.js',      // ゲームUI制御スクリプト
  './build/release.wasm', // WebAssembly AIエンジン（バイナリ）
  './manifest.json',      // PWAマニフェスト
  './icon-192.png',       // ホーム画面アイコン（192×192）
  './icon-512.png'        // ホーム画面アイコン（512×512、ストア表示用）
];

/**
 * installイベント: Service Workerの初回登録時またはSW更新時に発火
 *
 * 全アセットをキャッシュに追加する。
 * skipWaiting()により、既存のService Workerを待たずに即座に有効化する。
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  // 以前のService Workerがいても即座に新バージョンに切り替える
  self.skipWaiting();
});

/**
 * activateイベント: Service Workerが制御を開始するときに発火
 *
 * 現在のCACHE_NAME以外のキャッシュ（古いバージョン）を削除する。
 * clients.claim()により、既に開いているページをこのSWが即座に制御する。
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME) // 現在のバージョン以外を削除
          .map((k) => caches.delete(k))
      )
    )
  );
  // 現在開いているページをこのService Workerの管理下に入れる
  self.clients.claim();
});

/**
 * fetchイベント: ページがネットワークリクエストを行うたびに発火
 *
 * Cache-First戦略:
 *   1. キャッシュにあればキャッシュから応答（オフラインでも動作）
 *   2. キャッシュにない場合はネットワークにフォールバック
 *
 * この戦略により、一度ゲームを開いた後はオフラインでも遊べるようになる。
 */
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
