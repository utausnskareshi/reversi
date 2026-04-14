/**
 * リバーシ - ゲームUI制御
 *
 * 概要:
 *   WebAssembly（AssemblyScript製AIエンジン）とブラウザUIを接続するメインスクリプト。
 *   先攻・後攻選択、盤面描画、プレイヤー入力処理、AI思考呼び出し、ゲーム進行管理を担う。
 *
 * WASMとのデータやり取りについて:
 *   - WASMエンジンはビットボード（u64）で盤面を管理する
 *   - JavaScript側でu64を受け取るとBigIntになるが、bit63が立つと符号付き負値になる
 *   - BitboardToSet()内で BigInt.asUintN(64, val) を使って符号なし変換する（重要）
 */

/** @type {WebAssembly.Instance} WASMインスタンス（ロード後にセット） */
let wasmInstance = null;

/** @type {Object} WASMエクスポート関数群のショートカット */
let wasm = null;

/** プレイヤーが黒番（先攻）かどうか */
let playerIsBlack = true;

/** 現在の手番: true=黒番, false=白番 */
let currentIsBlack = true;

/** ゲーム進行中フラグ（クリック受付などの制御に使用） */
let gameActive = false;

/** AI思考中フラグ（思考中はプレイヤーのクリックを無効化） */
let aiThinking = false;

/** 最後に置かれた位置（ハイライト表示用、-1=なし） */
let lastMovePos = -1;

// ===== DOM要素の取得 =====
const startScreen   = document.getElementById('start-screen');
const gameScreen    = document.getElementById('game-screen');
const boardEl       = document.getElementById('board');
const blackCountEl  = document.getElementById('black-count');
const whiteCountEl  = document.getElementById('white-count');
const turnIndicator = document.getElementById('turn-indicator');
const messageArea   = document.getElementById('message-area');
const btnRestart    = document.getElementById('btn-restart');
const btnFirst      = document.getElementById('btn-first');
const btnSecond     = document.getElementById('btn-second');

// ===== WASMの読み込み =====

/**
 * WebAssemblyバイナリを非同期でロードし、エクスポート関数を初期化する
 *
 * WASMはローカルファイル（file://）では動作しないため、
 * HTTPサーバー経由でのアクセスが必要（`npm start` で起動できる）。
 */
async function loadWasm() {
  try {
    const response = await fetch('build/release.wasm');
    const buffer = await response.arrayBuffer();
    const module = await WebAssembly.instantiate(buffer, {
      env: {
        // AssemblyScriptの abort() 関数（パニック時に呼ばれる）
        abort: () => { console.error('WASM abort'); }
      }
    });
    wasmInstance = module.instance;
    wasm = wasmInstance.exports;
  } catch (e) {
    console.error('WASM読み込み失敗:', e);
    document.body.innerHTML =
      '<p style="color:red;text-align:center;padding:20px;">' +
      'WASMの読み込みに失敗しました。<br>ローカルHTTPサーバー経由でアクセスしてください。</p>';
  }
}

// ===== 盤面描画 =====

/**
 * 8×8の盤面セルをDOMに生成する
 * ゲーム開始時に1回だけ呼び出す（以降は再利用してクラスを書き換える）
 */
function createBoard() {
  boardEl.innerHTML = '';
  for (let i = 0; i < 64; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.pos = i; // クリック時に位置を識別するためのデータ属性
    cell.addEventListener('click', onCellClick);
    boardEl.appendChild(cell);
  }
}

/**
 * WASMから返るビットボード（u64）をJavaScriptのSet<number>に変換する
 *
 * 重要な注意点:
 *   WASMのu64（符号なし64ビット整数）はJavaScriptではBigIntとして返るが、
 *   bit63（h8コーナー）が立っている場合、符号付きBigIntとして負値になる。
 *   そのまま while (val > 0n) とすると即座にループが終了し、石が消えるバグが発生する。
 *   BigInt.asUintN(64, val) で符号なし変換することで正しく動作する。
 *
 * @param {BigInt} bb ビットボード値（WASMからのBigInt）
 * @returns {Set<number>} 石が置かれているマス位置のSet（0-63）
 */
function bitboardToSet(bb) {
  const set = new Set();
  let val = BigInt.asUintN(64, BigInt(bb)); // 符号なし64ビットに変換（bit63対策）
  let pos = 0;
  while (val > 0n) {
    if (val & 1n) set.add(pos);
    val >>= 1n;
    pos++;
  }
  return set;
}

/**
 * 盤面を現在のWASM状態に合わせて再描画する
 *
 * 描画内容:
 *   - 黒・白の石
 *   - 合法手マーカー（プレイヤーの手番のみ表示）
 *   - 最後に置かれた位置のハイライト
 *   - 石を置くアニメーション（placedPos）
 *   - 石が反転するアニメーション（flippedPositions）
 *
 * @param {Set<number>|null} flippedPositions 今回反転した位置のSet（アニメーション用、nullなら省略）
 * @param {number}           placedPos        今回置いた位置（アニメーション用、-1なら省略）
 */
function renderBoard(flippedPositions = null, placedPos = -1) {
  const blackBB = wasm.getBlackBoard();
  const whiteBB = wasm.getWhiteBoard();
  const blacks = bitboardToSet(blackBB);
  const whites = bitboardToSet(whiteBB);

  // 合法手マーカー: プレイヤーの手番かつゲーム進行中かつAI未思考時のみ表示
  const isPlayerTurn = (currentIsBlack === playerIsBlack) && gameActive && !aiThinking;
  let legalSet = new Set();
  if (isPlayerTurn) {
    const legalBB = wasm.getLegalMovesFor(currentIsBlack ? 1 : 0);
    legalSet = bitboardToSet(legalBB);
  }

  const cells = boardEl.children;
  for (let i = 0; i < 64; i++) {
    const cell = cells[i];
    cell.className = 'cell'; // クラスをリセット

    // 合法手マーカー（クリック可能な位置を薄い丸で示す）
    if (legalSet.has(i)) {
      cell.classList.add('legal');
    }

    // 直前に置かれたマスを金色の枠でハイライト
    if (i === lastMovePos) {
      cell.classList.add('last-move');
    }

    // 石の描画（既存のdiscエレメントを再利用してアニメーションを適用）
    let disc = cell.querySelector('.disc');
    if (blacks.has(i)) {
      if (!disc) {
        disc = document.createElement('div');
        cell.appendChild(disc);
      }
      disc.className = 'disc black';
      if (i === placedPos) disc.classList.add('place');           // 新たに置かれた石
      else if (flippedPositions && flippedPositions.has(i)) disc.classList.add('flip'); // 反転した石
    } else if (whites.has(i)) {
      if (!disc) {
        disc = document.createElement('div');
        cell.appendChild(disc);
      }
      disc.className = 'disc white';
      if (i === placedPos) disc.classList.add('place');
      else if (flippedPositions && flippedPositions.has(i)) disc.classList.add('flip');
    } else {
      // 石がないマスはdiscエレメントを削除
      if (disc) disc.remove();
    }
  }

  // スコア表示を更新
  blackCountEl.textContent = wasm.getBlackCount();
  whiteCountEl.textContent = wasm.getWhiteCount();
}

// ===== ゲーム進行 =====

/**
 * ゲームを開始する
 * 先攻・後攻選択ボタンから呼ばれる。
 *
 * @param {boolean} isFirst true=先攻（黒）, false=後攻（白）
 */
function startGame(isFirst) {
  playerIsBlack = isFirst;
  currentIsBlack = true; // 黒が常に先手（リバーシの標準ルール）
  gameActive = true;
  aiThinking = false;
  lastMovePos = -1;

  wasm.initBoard();  // WASMの盤面を初期状態にリセット
  createBoard();     // DOMの盤面セルを生成

  // 画面切り替え
  startScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  messageArea.textContent = '';
  messageArea.className = '';
  btnRestart.classList.remove('visible');

  renderBoard();
  updateTurnIndicator();

  // プレイヤーが後攻（白）の場合、先にAIが着手する
  if (!playerIsBlack) {
    scheduleAiMove();
  }
}

/**
 * ターン表示を更新する
 * プレイヤーの手番なら「あなたの番」、AI思考中なら「AI思考中...」と表示。
 */
function updateTurnIndicator() {
  if (!gameActive) return;

  const isPlayerTurn = currentIsBlack === playerIsBlack;
  if (isPlayerTurn) {
    turnIndicator.textContent = 'あなたの番';
    turnIndicator.classList.remove('thinking');
  } else {
    turnIndicator.textContent = 'AI思考中...';
    turnIndicator.classList.add('thinking'); // CSSでアクセント色にする
  }
}

/**
 * 盤面セルのクリックイベントハンドラ
 * プレイヤーが石を置く操作を処理する。
 *
 * @param {MouseEvent} e クリックイベント
 */
function onCellClick(e) {
  // ゲーム中でない、またはAI思考中はクリックを無視
  if (!gameActive || aiThinking) return;

  const pos = parseInt(e.currentTarget.dataset.pos);

  // プレイヤーの手番でなければ無視
  const isPlayerTurn = currentIsBlack === playerIsBlack;
  if (!isPlayerTurn) return;

  // 着手前の盤面を保存（反転する石を特定するために使用）
  const prevBlacks = bitboardToSet(wasm.getBlackBoard());
  const prevWhites = bitboardToSet(wasm.getWhiteBoard());

  // WASMに着手を送る（不正な手なら0が返る）
  const result = wasm.placePiece(pos, currentIsBlack ? 1 : 0);
  if (result === 0) return; // 不正な手（合法手でないマス）

  // 着手後の盤面と比較して反転した石を特定（アニメーション用）
  const newBlacks = bitboardToSet(wasm.getBlackBoard());
  const newWhites = bitboardToSet(wasm.getWhiteBoard());
  const flipped = new Set();
  if (currentIsBlack) {
    // 黒番: 新たに黒になったマスのうち今置いた場所以外が反転石
    for (const p of newBlacks) {
      if (!prevBlacks.has(p) && p !== pos) flipped.add(p);
    }
  } else {
    // 白番: 新たに白になったマスのうち今置いた場所以外が反転石
    for (const p of newWhites) {
      if (!prevWhites.has(p) && p !== pos) flipped.add(p);
    }
  }

  lastMovePos = pos;
  renderBoard(flipped, pos); // 反転・配置アニメーション付きで再描画

  // 次のターンの処理へ
  nextTurn();
}

/**
 * 次のターンに進む
 *
 * 処理フロー:
 *   1. ゲーム終了チェック（両者パスなら終局）
 *   2. 手番を交代
 *   3. 次のプレイヤーが合法手を持つか確認
 *      - なければパスメッセージを表示して手番を戻す
 *      - それでも合法手がなければゲーム終了
 *   4. AIの手番であれば AI 着手をスケジュール
 */
function nextTurn() {
  // ゲーム終了チェック（両者とも合法手なし）
  if (wasm.isGameOver()) {
    endGame();
    return;
  }

  // 手番交代
  currentIsBlack = !currentIsBlack;

  // パスチェック: 次のプレイヤーが合法手を持たない場合
  if (!wasm.hasLegalMove(currentIsBlack ? 1 : 0)) {
    const who = (currentIsBlack === playerIsBlack) ? 'あなた' : 'AI';
    messageArea.textContent = `${who}はパスです`;

    // 手番を元に戻す
    currentIsBlack = !currentIsBlack;

    // 元のプレイヤーも合法手がなければゲーム終了
    if (!wasm.hasLegalMove(currentIsBlack ? 1 : 0)) {
      endGame();
      return;
    }
  } else {
    messageArea.textContent = '';
  }

  updateTurnIndicator();
  renderBoard(); // 合法手マーカーを更新

  // AIの手番なら自動着手をスケジュール
  if (currentIsBlack !== playerIsBlack && gameActive) {
    scheduleAiMove();
  }
}

/**
 * AIの着手を非同期でスケジュールする
 *
 * requestAnimationFrame + setTimeout の組み合わせで
 * UIが確実に更新（AI思考中の表示など）された後に重い計算を始める。
 * これによりUIのフリーズを防ぐ。
 */
function scheduleAiMove() {
  aiThinking = true;
  updateTurnIndicator(); // 「AI思考中...」と表示
  renderBoard();         // 合法手マーカーを消す（AI手番中はマーカー不要）

  // UIの再描画を完了させてからAI計算を開始（50ms待機）
  requestAnimationFrame(() => {
    setTimeout(() => {
      executeAiMove();
    }, 50);
  });
}

/**
 * AIの着手を実行する
 *
 * WASMの computeBestMove() を呼び出してAIの最善手を求め、
 * 盤面に反映する。合法手がない場合はパス扱いで nextTurn() に委ねる。
 */
function executeAiMove() {
  if (!gameActive) return; // ゲームが終了していれば何もしない

  // 着手前の盤面を保存（反転石特定用）
  const prevBlacks = bitboardToSet(wasm.getBlackBoard());
  const prevWhites = bitboardToSet(wasm.getWhiteBoard());

  // AIに最善手を計算させる（Alpha-Beta探索、深さ7-8、終盤は完全読み）
  const bestMove = wasm.computeBestMove(currentIsBlack ? 1 : 0);

  if (bestMove < 0 || bestMove >= 64) {
    // 合法手なし → パス扱い
    aiThinking = false;
    nextTurn();
    return;
  }

  // AIの手を盤面に反映
  const placeResult = wasm.placePiece(bestMove, currentIsBlack ? 1 : 0);
  if (placeResult === 0) {
    // 着手失敗（本来起こらないはずだが安全のため処理）
    console.warn('AI move failed:', bestMove);
    aiThinking = false;
    nextTurn();
    return;
  }

  // 反転した石を特定（アニメーション用）
  const newBlacks = bitboardToSet(wasm.getBlackBoard());
  const newWhites = bitboardToSet(wasm.getWhiteBoard());
  const flipped = new Set();
  if (currentIsBlack) {
    for (const p of newBlacks) {
      if (!prevBlacks.has(p) && p !== bestMove) flipped.add(p);
    }
  } else {
    for (const p of newWhites) {
      if (!prevWhites.has(p) && p !== bestMove) flipped.add(p);
    }
  }

  lastMovePos = bestMove;
  aiThinking = false;
  renderBoard(flipped, bestMove); // 反転・配置アニメーション付きで再描画

  // 少し待ってから次のターン（石のアニメーション（0.4s）が完了してから進む）
  setTimeout(() => {
    nextTurn();
  }, 400);
}

/**
 * ゲーム終了処理
 *
 * 石数を集計して勝敗を判定し、結果メッセージを表示する。
 * 「もう一度遊ぶ」ボタンも表示する。
 */
function endGame() {
  gameActive = false;
  const bc = wasm.getBlackCount(); // 黒石の数
  const wc = wasm.getWhiteCount(); // 白石の数

  // プレイヤーとAIの石数を計算
  const playerCount = playerIsBlack ? bc : wc;
  const aiCount     = playerIsBlack ? wc : bc;

  let msg;
  if (playerCount > aiCount) {
    msg = `あなたの勝ち！ (${playerCount} - ${aiCount})`;
  } else if (playerCount < aiCount) {
    msg = `AIの勝ち (${aiCount} - ${playerCount})`;
  } else {
    msg = `引き分け (${playerCount} - ${aiCount})`;
  }

  turnIndicator.textContent = '終了';
  turnIndicator.classList.remove('thinking');
  messageArea.textContent = msg;
  messageArea.className = 'result'; // CSSで大きく表示
  btnRestart.classList.add('visible'); // リスタートボタンを表示

  // 合法手マーカーなしで最終盤面を再描画
  renderBoard();
}

// ===== イベントリスナー =====

/** 先攻（黒）ボタン: プレイヤーが黒番でゲーム開始 */
btnFirst.addEventListener('click', () => startGame(true));

/** 後攻（白）ボタン: プレイヤーが白番でゲーム開始（AIが先に指す） */
btnSecond.addEventListener('click', () => startGame(false));

/** もう一度遊ぶボタン: ゲーム画面を隠して開始画面に戻る */
btnRestart.addEventListener('click', () => {
  gameScreen.classList.add('hidden');
  startScreen.classList.remove('hidden');
});

// ===== 初期化 =====

/**
 * アプリ起動時にWASMを読み込む
 * 読み込みが完了するまでボタンは操作可能だが、
 * startGame()内でwasm.initBoard()を呼ぶため問題ない
 */
loadWasm().then(() => {
  // WASM読み込み完了 → 通常はここで何もしない
});
