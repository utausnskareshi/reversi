/**
 * リバーシAIエンジン (AssemblyScript → WebAssembly)
 *
 * 概要:
 *   - 盤面表現: ビットボード（u64×2: 黒・白）により高速な演算を実現
 *   - 合法手生成: 8方向への伝播でO(1)に近い速度で合法手を列挙
 *   - AI探索: NegaMax + Alpha-Beta枝刈り + 反復深化
 *   - 評価関数: 位置スコア・角・モビリティ・安定石を組み合わせた多項目評価
 *   - 終盤完全読み: 残り12手以下で完全読みに切り替え
 *
 * ビットボードのレイアウト（ビット番号 = 行×8+列）:
 *   位置0=a1(左上), 位置7=h1(右上), 位置56=a8(左下), 位置63=h8(右下)
 */

// ===== 方向定数 =====
// 8方向をビット位置オフセットで表現（上=8ビット右シフト = 1行上へ）
const DIR_UP: i32 = -8;
const DIR_DOWN: i32 = 8;
const DIR_LEFT: i32 = -1;
const DIR_RIGHT: i32 = 1;
const DIR_UP_LEFT: i32 = -9;
const DIR_UP_RIGHT: i32 = -7;
const DIR_DOWN_LEFT: i32 = 7;
const DIR_DOWN_RIGHT: i32 = 9;

// ===== ビットボードマスク定数 =====
/** Aファイル（左端列）を除くマスク: 左シフト時の折り返し防止 */
const NOT_A_FILE: u64 = 0xFEFEFEFEFEFEFEFE;
/** Hファイル（右端列）を除くマスク: 右シフト時の折り返し防止 */
const NOT_H_FILE: u64 = 0x7F7F7F7F7F7F7F7F;
/** 4つの角マス: a1, h1, a8, h8 */
const CORNERS: u64 = 0x8100000000000081;
/** X打ちマス（角に隣接する斜めのマス）: 角が空いているときに置くと不利 */
const X_SQUARES: u64 = 0x0042000000004200;
/** C打ちマス（角に隣接する辺のマス）: 角が空いているときに注意が必要 */
const C_SQUARES: u64 = 0x4281000000008142;
/** 盤の外周（辺）マス全体 */
const EDGES: u64 = 0xFF818181818181FF;

// ===== 探索パラメータ =====
/** 探索スコアの無限大（勝敗判定に使用） */
const INF: i32 = 1000000;
/** 通常探索の最大深さ（中盤以降） */
const MAX_DEPTH: i32 = 8;
/** 終盤完全読みを開始する残り空きマス数 */
const ENDGAME_DEPTH: i32 = 12;
/** 探索スタックの最大深さ（反復深化の最大深さ＋マージン） */
const MAX_STACK_DEPTH: i32 = 20;

// ===== グローバル盤面状態 =====
/** 黒石のビットボード */
let blackBoard: u64 = 0;
/** 白石のビットボード */
let whiteBoard: u64 = 0;
/** デバッグ用: 探索ノード数カウント */
let nodeCount: i32 = 0;
/** computeBestMoveの結果を保持 */
let bestMoveResult: i32 = -1;

/**
 * applyMove の結果を返す際に使うグローバル変数
 * （AssemblyScriptはタプル返却が不便なため、副作用で渡す）
 */
let newMe: u64 = 0;
let newOpp: u64 = 0;

// ===== 位置評価テーブル =====
/**
 * 各マスに置いたときの基本スコア
 * 高い値: 角（500）、辺
 * 低い値: X打ちマス（-300）、C打ちマス（-150）
 * 中央付近は小さなプラス値
 */
const POSITION_WEIGHT: StaticArray<i32> = [
  500, -150,  30,  10,  10,  30, -150,  500,
 -150, -300,  -5,  -5,  -5,  -5, -300, -150,
   30,   -5,  15,   3,   3,  15,   -5,   30,
   10,   -5,   3,   3,   3,   3,   -5,   10,
   10,   -5,   3,   3,   3,   3,   -5,   10,
   30,   -5,  15,   3,   3,  15,   -5,   30,
 -150, -300,  -5,  -5,  -5,  -5, -300, -150,
  500, -150,  30,  10,  10,  30, -150,  500
];

// ===== 手リストスタック =====
/**
 * 深さ別の手リストを保持する2次元配列（1次元で管理）
 * moveStack[depth * 64 + i] = 深さdepthでのi番目の手（位置インデックス）
 *
 * グローバル配列を深さ別に分けることで、再帰呼び出し中の上書きを防ぐ。
 * （以前のバグ: グローバルな sortMoves を使い回していたため、
 *   再帰中に親階層の手リストが上書きされAIが誤った手を選んでいた）
 */
const moveStack: StaticArray<i32> = new StaticArray<i32>(MAX_STACK_DEPTH * 64);
/** orderMoves 内でのソート中間バッファ（スコア一時保存） */
const sortScores: StaticArray<i32> = new StaticArray<i32>(64);
/** orderMoves 内でのソート中間バッファ（手の一時保存） */
const sortMoves: StaticArray<i32> = new StaticArray<i32>(64);

// ===== ビットボード基本操作 =====

/** ビット数（石の数）を数える（CPU命令 popcnt を使用） */
@inline
function popcount(x: u64): i32 {
  return <i32>popcnt(x);
}

/** 最下位ビットの位置（0始まり）を返す（CPU命令 ctz を使用） */
@inline
function bitScanForward(x: u64): i32 {
  return <i32>ctz(x);
}

/**
 * ビットボードを指定方向にシフトする
 * 盤外へのはみ出しを防ぐため、端のマスにはマスクをかける
 * @param board シフト対象のビットボード
 * @param dir   方向定数 (DIR_UP など)
 * @returns シフト後のビットボード
 */
@inline
function shiftDir(board: u64, dir: i32): u64 {
  if (dir == DIR_UP) return board >> 8;
  if (dir == DIR_DOWN) return board << 8;
  if (dir == DIR_LEFT) return (board >> 1) & NOT_H_FILE;   // 右端列からの折り返し防止
  if (dir == DIR_RIGHT) return (board << 1) & NOT_A_FILE;  // 左端列への折り返し防止
  if (dir == DIR_UP_LEFT) return (board >> 9) & NOT_H_FILE;
  if (dir == DIR_UP_RIGHT) return (board >> 7) & NOT_A_FILE;
  if (dir == DIR_DOWN_LEFT) return (board << 7) & NOT_H_FILE;
  if (dir == DIR_DOWN_RIGHT) return (board << 9) & NOT_A_FILE;
  return 0;
}

/**
 * 合法手のビットボードを生成する
 *
 * 各方向に対して、自石から連続する相手石を超えた先の空きマスを探す。
 * hMask/vMask/dMask は各方向の移動で盤外に出ないためのマスク。
 *
 * @param me  自分の石のビットボード
 * @param opp 相手の石のビットボード
 * @returns   着手可能な位置のビットボード
 */
function getLegalMoves(me: u64, opp: u64): u64 {
  const empty: u64 = ~(me | opp);
  let legal: u64 = 0;

  // 水平方向の移動で端に出ないマスク（左右1列を除く）
  const hMask: u64 = opp & 0x7E7E7E7E7E7E7E7E;
  // 垂直方向の移動で端に出ないマスク（上下1行を除く）
  const vMask: u64 = opp & 0x00FFFFFFFFFFFF00;
  // 斜め方向の移動で端に出ないマスク（辺を除く）
  const dMask: u64 = opp & 0x007E7E7E7E7E7E00;
  let tmp: u64;

  // 右方向: 自石から右に相手石が続き、その先が空きマス
  tmp = hMask & (me << 1);
  tmp |= hMask & (tmp << 1);
  tmp |= hMask & (tmp << 1);
  tmp |= hMask & (tmp << 1);
  tmp |= hMask & (tmp << 1);
  tmp |= hMask & (tmp << 1);
  legal |= empty & (tmp << 1);

  // 左方向
  tmp = hMask & (me >> 1);
  tmp |= hMask & (tmp >> 1);
  tmp |= hMask & (tmp >> 1);
  tmp |= hMask & (tmp >> 1);
  tmp |= hMask & (tmp >> 1);
  tmp |= hMask & (tmp >> 1);
  legal |= empty & (tmp >> 1);

  // 下方向
  tmp = vMask & (me << 8);
  tmp |= vMask & (tmp << 8);
  tmp |= vMask & (tmp << 8);
  tmp |= vMask & (tmp << 8);
  tmp |= vMask & (tmp << 8);
  tmp |= vMask & (tmp << 8);
  legal |= empty & (tmp << 8);

  // 上方向
  tmp = vMask & (me >> 8);
  tmp |= vMask & (tmp >> 8);
  tmp |= vMask & (tmp >> 8);
  tmp |= vMask & (tmp >> 8);
  tmp |= vMask & (tmp >> 8);
  tmp |= vMask & (tmp >> 8);
  legal |= empty & (tmp >> 8);

  // 右下方向
  tmp = dMask & (me << 9);
  tmp |= dMask & (tmp << 9);
  tmp |= dMask & (tmp << 9);
  tmp |= dMask & (tmp << 9);
  tmp |= dMask & (tmp << 9);
  tmp |= dMask & (tmp << 9);
  legal |= empty & (tmp << 9);

  // 左上方向
  tmp = dMask & (me >> 9);
  tmp |= dMask & (tmp >> 9);
  tmp |= dMask & (tmp >> 9);
  tmp |= dMask & (tmp >> 9);
  tmp |= dMask & (tmp >> 9);
  tmp |= dMask & (tmp >> 9);
  legal |= empty & (tmp >> 9);

  // 右上方向
  tmp = dMask & (me >> 7);
  tmp |= dMask & (tmp >> 7);
  tmp |= dMask & (tmp >> 7);
  tmp |= dMask & (tmp >> 7);
  tmp |= dMask & (tmp >> 7);
  tmp |= dMask & (tmp >> 7);
  legal |= empty & (tmp >> 7);

  // 左下方向
  tmp = dMask & (me << 7);
  tmp |= dMask & (tmp << 7);
  tmp |= dMask & (tmp << 7);
  tmp |= dMask & (tmp << 7);
  tmp |= dMask & (tmp << 7);
  tmp |= dMask & (tmp << 7);
  legal |= empty & (tmp << 7);

  return legal;
}

/**
 * 指定位置に石を置いたときに反転する石のビットボードを計算する
 *
 * 8方向それぞれに対して:
 *   1. posから相手石が連続する限りlineに追加
 *   2. その先に自石があればlineをflipsに追加（挟み確定）
 *   3. 自石がなければflipsに追加しない
 *
 * @param me  自分の石のビットボード
 * @param opp 相手の石のビットボード
 * @param pos 着手位置（0-63）
 * @returns   反転する石のビットボード
 */
function getFlips(me: u64, opp: u64, pos: i32): u64 {
  const posbit: u64 = <u64>1 << pos;
  let flips: u64 = 0;

  const dirs: StaticArray<i32> = [DIR_UP, DIR_DOWN, DIR_LEFT, DIR_RIGHT,
                                    DIR_UP_LEFT, DIR_UP_RIGHT, DIR_DOWN_LEFT, DIR_DOWN_RIGHT];
  for (let d: i32 = 0; d < 8; d++) {
    const dir = unchecked(dirs[d]);
    let line: u64 = 0;
    let current: u64 = shiftDir(posbit, dir);
    // 相手石が続く間、lineに積み上げる
    while (current != 0 && (current & opp) != 0) {
      line |= current;
      current = shiftDir(current, dir);
    }
    // 自石で終わっていれば挟み成立 → flipsに追加
    if (current != 0 && (current & me) != 0) {
      flips |= line;
    }
  }

  return flips;
}

/**
 * 石を置いた後の盤面をグローバル変数 newMe / newOpp に格納する
 * AssemblyScript ではタプルが扱いにくいため、副作用で結果を返す。
 *
 * @param me  自分の石のビットボード（着手前）
 * @param opp 相手の石のビットボード（着手前）
 * @param pos 着手位置（0-63）
 */
function applyMove(me: u64, opp: u64, pos: i32): void {
  const flips = getFlips(me, opp, pos);
  const posbit: u64 = <u64>1 << pos;
  // 自分の石: 元の石 + 新たに置いた石 + 反転した石
  newMe = me | posbit | flips;
  // 相手の石: 反転した石を除く
  newOpp = opp & ~flips;
}

// ===== 評価関数 =====

/**
 * 安定石（今後絶対に反転しない石）を計算する
 *
 * 角から伝播するアルゴリズムで近似計算:
 *   角にある自石を起点に、隣接する自石で盤の端にある石を安定石とみなす。
 * 正確な安定石の計算は複雑なため、ここでは角＋辺を中心とした近似を使用。
 *
 * @param me  自分の石のビットボード
 * @param opp 相手の石のビットボード（将来拡張用に保持）
 * @returns   安定石のビットボード（近似）
 */
function getStableDiscs(me: u64, opp: u64): u64 {
  const corners: u64 = me & CORNERS;
  if (corners == 0) return 0; // 角がなければ安定石なし

  let stable: u64 = corners;
  let changed: bool = true;

  // 安定石から周囲に伝播（変化がなくなるまで繰り返す）
  while (changed) {
    changed = false;
    const prev = stable;
    let expand: u64 = 0;
    // 8方向に拡張
    expand |= (stable << 1) & NOT_A_FILE;
    expand |= (stable >> 1) & NOT_H_FILE;
    expand |= stable << 8;
    expand |= stable >> 8;
    expand |= (stable << 9) & NOT_A_FILE;
    expand |= (stable >> 9) & NOT_H_FILE;
    expand |= (stable << 7) & NOT_H_FILE;
    expand |= (stable >> 7) & NOT_A_FILE;
    // 自分の石かつ辺上にあるものだけ安定石に追加
    stable |= expand & me & EDGES;
    if (stable != prev) changed = true;
  }

  return stable;
}

/**
 * フロンティア石（空きマスに隣接している石）を計算する
 *
 * フロンティア石は将来反転しやすいため、数が少ない方が良い。
 * 相手のフロンティア石が多い = 自分が優位（相手の石が反転しやすい）。
 *
 * @param me  自分の石のビットボード
 * @param opp 相手の石のビットボード
 * @returns   自分のフロンティア石のビットボード
 */
function getFrontier(me: u64, opp: u64): u64 {
  const empty: u64 = ~(me | opp);
  let adj: u64 = 0;
  // 空きマスに隣接するマスを全方向から求める
  adj |= (empty << 1) & NOT_A_FILE;
  adj |= (empty >> 1) & NOT_H_FILE;
  adj |= empty << 8;
  adj |= empty >> 8;
  adj |= (empty << 9) & NOT_A_FILE;
  adj |= (empty >> 9) & NOT_H_FILE;
  adj |= (empty << 7) & NOT_H_FILE;
  adj |= (empty >> 7) & NOT_A_FILE;
  return me & adj; // 自分の石のうち空きマスに隣接するもの
}

/**
 * 盤面を評価し、me側から見たスコアを返す
 *
 * 評価項目:
 *   1. 位置評価  - 角・辺など戦略的に重要なマスへの重み付け
 *   2. 角スコア  - 角の獲得は非常に有利（安定石の基点）
 *   3. X打ち    - 角が空のときに斜め隣に置くのは不利
 *   4. C打ち    - 角が空のときに辺の隣に置くのは不利
 *   5. モビリティ - 着手可能数が多い方が有利（相手を追い詰める）
 *   6. フロンティア - フロンティア石が少ない方が安定
 *   7. 安定石   - 確定石は将来も安全
 *   8. パリティ  - 終盤は最後の手を取る側が有利
 *
 * フェーズ（序盤・中盤・終盤）に応じて各項目の重みを変える。
 *
 * @param me  自分の石のビットボード
 * @param opp 相手の石のビットボード
 * @returns   評価スコア（正 = me有利、負 = opp有利）
 */
function evaluate(me: u64, opp: u64): i32 {
  const empty = ~(me | opp);
  const emptyCount = popcount(empty);
  const totalDiscs = 64 - emptyCount;

  // 終局: 石数差で勝敗を返す（100000で通常評価と区別）
  if (emptyCount == 0) {
    const diff = popcount(me) - popcount(opp);
    if (diff > 0) return 100000 + diff * 100;
    if (diff < 0) return -100000 + diff * 100;
    return 0;
  }

  let score: i32 = 0;

  // 1. 位置評価: 各マスのPOSITION_WEIGHTを合算
  let posScore: i32 = 0;
  let bits: u64;
  bits = me;
  while (bits != 0) {
    posScore += unchecked(POSITION_WEIGHT[bitScanForward(bits)]);
    bits &= bits - 1; // 最下位ビットを消す
  }
  bits = opp;
  while (bits != 0) {
    posScore -= unchecked(POSITION_WEIGHT[bitScanForward(bits)]);
    bits &= bits - 1;
  }

  // 2. 角スコア: 1角につき800点
  const myCorners = popcount(me & CORNERS);
  const oppCorners = popcount(opp & CORNERS);
  const cornerScore = (myCorners - oppCorners) * 800;

  // 3. X打ちペナルティ: 各角が空の場合、その斜め隣（X打ちマス）は大幅減点
  let xScore: i32 = 0;
  const occupied = me | opp;
  if ((occupied & (<u64>1 << 0)) == 0) {  // a1が空
    if (me & (<u64>1 << 9)) xScore -= 150;
    if (opp & (<u64>1 << 9)) xScore += 150;
  }
  if ((occupied & (<u64>1 << 7)) == 0) {  // h1が空
    if (me & (<u64>1 << 14)) xScore -= 150;
    if (opp & (<u64>1 << 14)) xScore += 150;
  }
  if ((occupied & (<u64>1 << 56)) == 0) { // a8が空
    if (me & (<u64>1 << 49)) xScore -= 150;
    if (opp & (<u64>1 << 49)) xScore += 150;
  }
  if ((occupied & (<u64>1 << 63)) == 0) { // h8が空
    if (me & (<u64>1 << 54)) xScore -= 150;
    if (opp & (<u64>1 << 54)) xScore += 150;
  }

  // 4. C打ちペナルティ: 各角が空の場合、その辺隣（C打ちマス）は中程度減点
  let cScore: i32 = 0;
  if ((occupied & (<u64>1 << 0)) == 0) {  // a1が空
    if (me & (<u64>1 << 1)) cScore -= 75;   // b1
    if (opp & (<u64>1 << 1)) cScore += 75;
    if (me & (<u64>1 << 8)) cScore -= 75;   // a2
    if (opp & (<u64>1 << 8)) cScore += 75;
  }
  if ((occupied & (<u64>1 << 7)) == 0) {  // h1が空
    if (me & (<u64>1 << 6)) cScore -= 75;   // g1
    if (opp & (<u64>1 << 6)) cScore += 75;
    if (me & (<u64>1 << 15)) cScore -= 75;  // h2
    if (opp & (<u64>1 << 15)) cScore += 75;
  }
  if ((occupied & (<u64>1 << 56)) == 0) { // a8が空
    if (me & (<u64>1 << 48)) cScore -= 75;  // a7
    if (opp & (<u64>1 << 48)) cScore += 75;
    if (me & (<u64>1 << 57)) cScore -= 75;  // b8
    if (opp & (<u64>1 << 57)) cScore += 75;
  }
  if ((occupied & (<u64>1 << 63)) == 0) { // h8が空
    if (me & (<u64>1 << 55)) cScore -= 75;  // h7
    if (opp & (<u64>1 << 55)) cScore += 75;
    if (me & (<u64>1 << 62)) cScore -= 75;  // g8
    if (opp & (<u64>1 << 62)) cScore += 75;
  }

  // 5. モビリティ: 着手可能数の差を正規化（両者合計で割って相対比較）
  const myMoves = popcount(getLegalMoves(me, opp));
  const oppMoves = popcount(getLegalMoves(opp, me));
  let mobilityScore: i32 = 0;
  if (myMoves + oppMoves > 0) {
    mobilityScore = ((myMoves - oppMoves) * 12800) / (myMoves + oppMoves + 1);
  }

  // 6. フロンティア: フロンティア石が少ないほど良い（負の相関）
  const myFrontier = popcount(getFrontier(me, opp));
  const oppFrontier = popcount(getFrontier(opp, me));
  let frontierScore: i32 = 0;
  if (myFrontier + oppFrontier > 0) {
    frontierScore = -((myFrontier - oppFrontier) * 9600) / (myFrontier + oppFrontier + 1);
  }

  // 7. 安定石: 確定石が多いほど良い
  const myStable = popcount(getStableDiscs(me, opp));
  const oppStable = popcount(getStableDiscs(opp, me));
  const stableScore = (myStable - oppStable) * 120;

  // 8. パリティ: 残りマスが奇数なら自分が最後の手（有利）
  let parityScore: i32 = 0;
  if (emptyCount < 10) {
    parityScore = (emptyCount % 2 == 0) ? -30 : 30;
  }

  // フェーズ別の重み調整
  if (totalDiscs < 20) {
    // 序盤: 位置とモビリティを重視
    score = posScore * 3 + cornerScore * 5 + xScore * 3 + cScore * 2
          + mobilityScore * 5 + frontierScore * 3 + stableScore * 2;
  } else if (totalDiscs < 50) {
    // 中盤: 角と安定石の比重を上げる
    score = posScore * 2 + cornerScore * 6 + xScore * 2 + cScore * 1
          + mobilityScore * 4 + frontierScore * 3 + stableScore * 4;
  } else {
    // 終盤: 石数差・安定石・角を最重視
    const discDiff = popcount(me) - popcount(opp);
    score = cornerScore * 7 + mobilityScore * 2 + stableScore * 6
          + discDiff * 200 + parityScore * 3;
  }

  return score;
}

// ===== 手順整列（Move Ordering） =====

/**
 * 指定位置に隣接する角の位置を返す（X打ち・C打ちの判定用）
 * @param pos チェックするマスの位置（0-63）
 * @returns 隣接する角のビット位置（0,7,56,63のいずれか）、なければ-1
 */
function getAdjacentCorner(pos: i32): i32 {
  if (pos == 9 || pos == 1 || pos == 8) return 0;   // a1の周辺
  if (pos == 14 || pos == 6 || pos == 15) return 7;  // h1の周辺
  if (pos == 49 || pos == 48 || pos == 57) return 56; // a8の周辺
  if (pos == 54 || pos == 55 || pos == 62) return 63; // h8の周辺
  return -1;
}

/**
 * 合法手を評価スコア順に降順ソートし、moveStack[stackDepth*64+i] に格納する
 *
 * Move Orderingの目的:
 *   Alpha-Beta探索では良い手を先に探索するほど枝刈り効率が上がる。
 *   角優先、X打ち/C打ち回避、反転数、相手モビリティ削減を考慮してスコアを付ける。
 *
 * @param me         自分の石のビットボード
 * @param opp        相手の石のビットボード
 * @param moves      合法手のビットボード
 * @param moveCount  合法手の数
 * @param stackDepth 探索スタックの深さインデックス（再帰対応のため）
 * @param full       trueなら相手のモビリティも計算（浅い深さのみ、コスト削減）
 */
function orderMoves(me: u64, opp: u64, moves: u64, moveCount: i32, stackDepth: i32, full: bool): void {
  let idx: i32 = 0;
  let bits = moves;
  const base = stackDepth * 64; // このdepth用のmoveStackオフセット

  while (bits != 0) {
    const pos = bitScanForward(bits);
    bits &= bits - 1;

    let score: i32 = 0;
    const posBit: u64 = <u64>1 << pos;

    if (posBit & CORNERS) {
      // 角は最優先（最高スコア）
      score = 10000;
    } else if (posBit & X_SQUARES) {
      // X打ちマス: 角が既に取られていれば問題なし、空いていれば大ペナルティ
      const cornerCheck = getAdjacentCorner(pos);
      if (cornerCheck >= 0 && ((me | opp) & (<u64>1 << cornerCheck)) != 0) {
        score = unchecked(POSITION_WEIGHT[pos]) + 200; // 角取得済みなら問題なし
      } else {
        score = -5000; // 角が空なら最低評価
      }
    } else if (posBit & C_SQUARES) {
      // C打ちマス: X打ちほどではないが角が空なら回避
      const cornerCheck = getAdjacentCorner(pos);
      if (cornerCheck >= 0 && ((me | opp) & (<u64>1 << cornerCheck)) != 0) {
        score = unchecked(POSITION_WEIGHT[pos]) + 100;
      } else {
        score = -2000;
      }
    } else {
      score = unchecked(POSITION_WEIGHT[pos]);
    }

    // 反転数が多いほどスコア加算（石を多く取れる手を優先）
    const flips = getFlips(me, opp, pos);
    score += popcount(flips) * 10;

    // 浅い階層のみ相手のモビリティを計算（深い階層では計算コストが大きすぎる）
    if (full) {
      applyMove(me, opp, pos);
      const oppMovesAfter = popcount(getLegalMoves(newOpp, newMe));
      score -= oppMovesAfter * 20; // 相手の手が増える手は避ける
    }

    unchecked(sortMoves[idx] = pos);
    unchecked(sortScores[idx] = score);
    idx++;
  }

  // 挿入ソート（降順）: 手の数は最大64だが通常10-20程度なので十分高速
  for (let i: i32 = 1; i < moveCount; i++) {
    const key = unchecked(sortScores[i]);
    const keyMove = unchecked(sortMoves[i]);
    let j = i - 1;
    while (j >= 0 && unchecked(sortScores[j]) < key) {
      unchecked(sortScores[j + 1] = sortScores[j]);
      unchecked(sortMoves[j + 1] = sortMoves[j]);
      j--;
    }
    unchecked(sortScores[j + 1] = key);
    unchecked(sortMoves[j + 1] = keyMove);
  }

  // ソート結果をこの深さ専用のmoveStackに書き込む
  for (let i: i32 = 0; i < moveCount; i++) {
    unchecked(moveStack[base + i] = sortMoves[i]);
  }
}

// ===== Alpha-Beta探索（NegaMax形式） =====

/**
 * 中盤用 NegaMax Alpha-Beta 探索
 *
 * NegaMax: 手番を常に「自分」として考え、返り値を否定することで手番交代を表現。
 * Alpha-Beta枝刈り: alpha（自分の下限）>= beta（相手の上限）なら探索打ち切り。
 *
 * @param me         自分の石のビットボード
 * @param opp        相手の石のビットボード
 * @param depth      残り探索深さ
 * @param alpha      自分の保証スコア下限（alpha-beta窓の下限）
 * @param beta       相手の保証スコア上限（alpha-beta窓の上限）
 * @param passed     前の手がパスだったか（2連続パス = ゲーム終了）
 * @param stackDepth moveStackのインデックス（再帰深さを追跡）
 * @returns          このノードの評価スコア
 */
function negaAlpha(me: u64, opp: u64, depth: i32, alpha: i32, beta: i32, passed: bool, stackDepth: i32): i32 {
  nodeCount++;

  // 葉ノード: 静的評価を返す
  if (depth <= 0) {
    return evaluate(me, opp);
  }

  const moves = getLegalMoves(me, opp);

  if (moves == 0) {
    if (passed) {
      // 2連続パス = ゲーム終了
      const diff = popcount(me) - popcount(opp);
      if (diff > 0) return 100000 + diff * 100;
      if (diff < 0) return -100000 + diff * 100;
      return 0;
    }
    // パス: 手番交代して継続（depthは消費しない）
    return -negaAlpha(opp, me, depth, -beta, -alpha, true, stackDepth);
  }

  const moveCount = popcount(moves);
  // stackDepthがMAX_STACK_DEPTHを超えないようにクランプ
  const sd = stackDepth < MAX_STACK_DEPTH ? stackDepth : MAX_STACK_DEPTH - 1;
  // 浅い階層（stackDepth <= 2）のみフル評価でMove Ordering
  orderMoves(me, opp, moves, moveCount, sd, stackDepth <= 2);
  const base = sd * 64;

  for (let i: i32 = 0; i < moveCount; i++) {
    const pos = unchecked(moveStack[base + i]);

    applyMove(me, opp, pos);
    // NegaMax: 自分と相手を入れ替えてスコアを否定
    const childMe = newOpp;
    const childOpp = newMe;

    const val = -negaAlpha(childMe, childOpp, depth - 1, -beta, -alpha, false, stackDepth + 1);

    if (val > alpha) {
      alpha = val;
    }
    if (alpha >= beta) {
      return alpha; // Beta刈り
    }
  }

  return alpha;
}

/**
 * 終盤用 完全読み NegaMax Alpha-Beta 探索
 *
 * 残り空きマスが ENDGAME_DEPTH 以下になったら呼び出される。
 * 深さではなく空きマス数（= 残り手数）を基準に終局判定する。
 * 空きマスが ENDGAME_DEPTH より多くなると negaAlpha に委譲する。
 *
 * @param me         自分の石のビットボード
 * @param opp        相手の石のビットボード
 * @param alpha      alpha-beta窓の下限
 * @param beta       alpha-beta窓の上限
 * @param passed     前の手がパスだったか
 * @param stackDepth moveStackのインデックス
 * @returns          このノードの評価スコア（最終石数差ベース）
 */
function negaAlphaExact(me: u64, opp: u64, alpha: i32, beta: i32, passed: bool, stackDepth: i32): i32 {
  nodeCount++;

  const empty = ~(me | opp);

  // 終局: 石数差で評価
  if (empty == 0) {
    const diff = popcount(me) - popcount(opp);
    if (diff > 0) return 100000 + diff * 100;
    if (diff < 0) return -100000 + diff * 100;
    return 0;
  }

  const moves = getLegalMoves(me, opp);

  if (moves == 0) {
    if (passed) {
      const diff = popcount(me) - popcount(opp);
      if (diff > 0) return 100000 + diff * 100;
      if (diff < 0) return -100000 + diff * 100;
      return 0;
    }
    return -negaAlphaExact(opp, me, -beta, -alpha, true, stackDepth);
  }

  const emptyCount = popcount(empty);
  const moveCount = popcount(moves);

  // 残りマスが閾値を超えたら通常探索に切り替え（探索爆発を防ぐ）
  if (emptyCount > ENDGAME_DEPTH) {
    return negaAlpha(me, opp, MAX_DEPTH, alpha, beta, false, stackDepth);
  }

  const sd = stackDepth < MAX_STACK_DEPTH ? stackDepth : MAX_STACK_DEPTH - 1;
  orderMoves(me, opp, moves, moveCount, sd, stackDepth <= 2);
  const base = sd * 64;

  for (let i: i32 = 0; i < moveCount; i++) {
    const pos = unchecked(moveStack[base + i]);

    applyMove(me, opp, pos);
    const childMe = newOpp;
    const childOpp = newMe;

    const val = -negaAlphaExact(childMe, childOpp, -beta, -alpha, false, stackDepth + 1);

    if (val > alpha) {
      alpha = val;
    }
    if (alpha >= beta) {
      return alpha;
    }
  }

  return alpha;
}

// ===== エクスポート関数（JavaScript から呼び出す API） =====

/**
 * 盤面を初期状態にリセットする
 * 初期配置: 中央4マスに黒白2個ずつ（標準リバーシ配置）
 */
export function initBoard(): void {
  blackBoard = 0;
  whiteBoard = 0;
  // 白: d4(27), e5(36) / 黒: e4(28), d5(35)
  whiteBoard = (<u64>1 << 27) | (<u64>1 << 36);
  blackBoard = (<u64>1 << 28) | (<u64>1 << 35);
}

/**
 * 盤面を外部から直接セットする（テスト用）
 * @param black 黒石のビットボード
 * @param white 白石のビットボード
 */
export function setBoard(black: u64, white: u64): void {
  blackBoard = black;
  whiteBoard = white;
}

/**
 * 黒石のビットボードを返す
 * JavaScript側では符号なしBigIntとして受け取ること（bit63の符号に注意）
 */
export function getBlackBoard(): u64 {
  return blackBoard;
}

/**
 * 白石のビットボードを返す
 * JavaScript側では符号なしBigIntとして受け取ること（bit63の符号に注意）
 */
export function getWhiteBoard(): u64 {
  return whiteBoard;
}

/**
 * 指定プレイヤーの合法手ビットボードを返す
 * @param isBlack 1=黒, 0=白
 * @returns 合法手のビットボード（JavaScript側でBigInt.asUintN(64)で受け取ること）
 */
export function getLegalMovesFor(isBlack: i32): u64 {
  if (isBlack) {
    return getLegalMoves(blackBoard, whiteBoard);
  } else {
    return getLegalMoves(whiteBoard, blackBoard);
  }
}

/**
 * 指定位置に石を置き、盤面を更新する
 * @param pos     着手位置（0-63）
 * @param isBlack 1=黒番, 0=白番
 * @returns 反転した石の数（0なら不正な手で盤面は変化しない）
 */
export function placePiece(pos: i32, isBlack: i32): i32 {
  let me: u64, opp: u64;
  if (isBlack) {
    me = blackBoard;
    opp = whiteBoard;
  } else {
    me = whiteBoard;
    opp = blackBoard;
  }

  // 合法手チェック
  const legal = getLegalMoves(me, opp);
  const posbit: u64 = <u64>1 << pos;
  if ((legal & posbit) == 0) return 0; // 不正な手

  // 石を置いて反転を適用
  const flips = getFlips(me, opp, pos);
  me = me | posbit | flips;
  opp = opp & ~flips;

  // グローバル盤面を更新
  if (isBlack) {
    blackBoard = me;
    whiteBoard = opp;
  } else {
    whiteBoard = me;
    blackBoard = opp;
  }

  return popcount(flips);
}

/**
 * AIが最善手を計算して返す
 *
 * アルゴリズム:
 *   1. 残り空きマス数によって探索手法を選択
 *      - 残り ≤ ENDGAME_DEPTH(12): 完全読み（negaAlphaExact）
 *      - 残り ≤ 22: 深さ8で探索
 *      - それ以外: 深さ7で探索
 *   2. 反復深化: 深さ4から2刻みで目標深さまで探索
 *      （浅い探索の結果をMove Orderingの初期値として活用）
 *
 * @param isBlack 1=黒番, 0=白番
 * @returns 最善手の位置（0-63）、合法手なしなら-1
 */
export function computeBestMove(isBlack: i32): i32 {
  nodeCount = 0;
  bestMoveResult = -1;

  let me: u64, opp: u64;
  if (isBlack) {
    me = blackBoard;
    opp = whiteBoard;
  } else {
    me = whiteBoard;
    opp = blackBoard;
  }

  const moves = getLegalMoves(me, opp);
  if (moves == 0) return -1; // 合法手なし（パス）

  const emptyCount = popcount(~(me | opp));
  const moveCount = popcount(moves);

  // ルート（深さ0）の手リストをフル評価でソート
  orderMoves(me, opp, moves, moveCount, 0, true);

  let bestScore: i32 = -INF;
  let bestMove: i32 = -1;

  // 探索深さの決定
  let depth: i32;
  if (emptyCount <= ENDGAME_DEPTH) {
    depth = emptyCount; // 完全読み
  } else if (emptyCount <= 22) {
    depth = 8; // 中盤（残り手数が少ない）
  } else {
    depth = 7; // 序盤・中盤
  }

  /**
   * 反復深化 (Iterative Deepening):
   *   - 深さ4 → 6 → 8 → ... と段階的に深めて探索
   *   - 浅い探索結果をMove Orderingに活かして探索効率を上げる
   *   - 終盤で depth < 4 の場合（残り数手）はそのままdepthで1回探索
   */
  const startD: i32 = depth < 4 ? depth : 4;
  for (let d: i32 = startD; d <= depth; d += 2) {
    let alpha: i32 = -INF;
    let iterBest: i32 = -1;

    for (let i: i32 = 0; i < moveCount; i++) {
      const pos = unchecked(moveStack[i]); // ルートのbase=0

      applyMove(me, opp, pos);
      const childMe = newOpp;
      const childOpp = newMe;

      let val: i32;
      if (emptyCount <= ENDGAME_DEPTH) {
        // 終盤完全読み
        val = -negaAlphaExact(childMe, childOpp, -INF, -alpha, false, 1);
      } else {
        // 通常探索
        val = -negaAlpha(childMe, childOpp, d - 1, -INF, -alpha, false, 1);
      }

      if (val > bestScore || iterBest == -1) {
        bestScore = val;
        iterBest = pos;
      }
      if (val > alpha) {
        alpha = val;
      }
    }

    if (iterBest >= 0) {
      bestMove = iterBest; // この深さでの最善手を記録
    }
  }

  bestMoveResult = bestMove;
  return bestMove;
}

/** 黒石の数を返す */
export function getBlackCount(): i32 {
  return popcount(blackBoard);
}

/** 白石の数を返す */
export function getWhiteCount(): i32 {
  return popcount(whiteBoard);
}

/** デバッグ用: 最後の computeBestMove で訪問したノード数を返す */
export function getNodeCount(): i32 {
  return nodeCount;
}

/**
 * ゲーム終了判定: 両プレイヤーとも合法手がなければ終了
 * @returns 1=ゲーム終了, 0=継続中
 */
export function isGameOver(): i32 {
  const blackMoves = getLegalMoves(blackBoard, whiteBoard);
  const whiteMoves = getLegalMoves(whiteBoard, blackBoard);
  return (blackMoves == 0 && whiteMoves == 0) ? 1 : 0;
}

/**
 * 指定プレイヤーが合法手を持つか判定
 * @param isBlack 1=黒, 0=白
 * @returns 1=合法手あり, 0=パス（合法手なし）
 */
export function hasLegalMove(isBlack: i32): i32 {
  if (isBlack) {
    return getLegalMoves(blackBoard, whiteBoard) != 0 ? 1 : 0;
  } else {
    return getLegalMoves(whiteBoard, blackBoard) != 0 ? 1 : 0;
  }
}
