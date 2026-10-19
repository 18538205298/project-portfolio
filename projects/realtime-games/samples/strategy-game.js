'use strict';

/* ============================================================
 *  猜拳棋 —— 规则层
 *
 *  玩法：
 *    · 一块 cols×rows 的棋盘（默认 7 列 × 9 行，尺寸是参数，见下面的 CFG）
 *    · 每人 10 枚棋子：3 石头、3 剪刀、3 布，外加 1 枚随机（石头/剪刀/布）
 *    · 开局随机撒在「靠近自己的那几行」里，一个格子最多一枚棋子
 *    · 轮流行动，一次只动一枚棋子，最多走 3 格（可拐弯）
 *    · 不能穿过别的棋子；压到对方棋子上就能吃掉它 —— 但必须是你克制它
 *      （石头吃剪刀、剪刀吃布、布吃石头）；吃不了的棋子挡路
 *    · 只有「对方压到我身上」我才会死（不会因为挨着就死）
 *    · 核心胜负：石头、剪刀、布三种棋子必须都在——任何一种被吃光就输
 *    · 双方都无法再吃子时结算，谁剩的棋子多谁赢
 *
 *  本文件不做任何 IO，方便单独测规则。
 * ============================================================ */

function intEnv(name, def, min, max) {
  const v = Number(process.env[name]);
  if (!Number.isFinite(v) || v <= 0) return def;
  return Math.min(max, Math.max(min, Math.floor(v)));
}
function boolEnv(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return !(v === '0' || v === 'false' || v === 'no');
}

const TYPES = ['R', 'S', 'P'];
const NAMES = { R: '石头', S: '剪刀', P: '布' };
const ICONS = { R: '✊', S: '✌', P: '✋' };
/** 谁克制谁：石头克制剪刀、剪刀克制布、布克制石头 */
const BEATS = { R: 'S', S: 'P', P: 'R' };
const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

/** 全部可调参数。想改棋盘大小就改 cols / rows（也可以用环境变量覆盖）。 */
const CFG = {
  cols: intEnv('COLS', 7, 3, 15),          // 棋盘列数
  rows: intEnv('ROWS', 9, 4, 15),          // 棋盘行数
  stepMax: intEnv('STEP_MAX', 3, 1, 4),    // 一回合最多走几格
  basePerType: intEnv('BASE_PER_TYPE', 3, 1, 8), // 每种基础棋子数
  extraRandom: intEnv('EXTRA_RANDOM', 1, 0, 4),  // 额外随机棋子数
  idleSettle: intEnv('IDLE_SETTLE', 60, 6, 999), // 连续多少手没吃子就强制结算
  noCapGrace: intEnv('NO_CAP_GRACE', 6, 2, 40),  // 双方都吃不到子后，再过几手才结算
  mirror: boolEnv('MIRROR_LAYOUT', false), // 是否让双方布局镜像对称（默认为否，各撒各的）
};

// 每人靠自己的行数：rows=9 时上下各 4 行，中间 1 行是中立区
CFG.homeRows = Math.max(1, Math.floor((CFG.rows - 1) / 2));
// 一方的主场格子数，也是棋子数上限
CFG.capacity = CFG.cols * CFG.homeRows;
CFG.piecesPerPlayer = Math.min(CFG.capacity, CFG.basePerType * 3 + CFG.extraRandom);

const idx = (r, c) => r * CFG.cols + c;
const inBounds = (r, c) => r >= 0 && r < CFG.rows && c >= 0 && c < CFG.cols;
const otherSide = (s) => (s === 0 ? 1 : 0);
const sideName = (s) => (s === 0 ? '上方' : '下方');
const beats = (a, b) => BEATS[a] === b;
/** 沙盒里也有 player 的显示名，统一放这里 */
const coord = (r, c) => `${r + 1}行${c + 1}列`;

/** 自家那几行的行号 */
function homeRowRange(side) {
  const h = CFG.homeRows;
  return side === 0 ? [0, h - 1] : [CFG.rows - h, CFG.rows - 1];
}
function isHome(r, side) {
  const [a, b] = homeRowRange(side);
  return r >= a && r <= b;
}

/* ---------------- 基础状态 ---------------- */

class Room {
  constructor(id) {
    this.id = id;
    /** @type {Map<string, {id:string, ws:any}>} */
    this.players = new Map();
    this.order = [];
    /** playerId -> 0(上方) / 1(下方) */
    this.sideOf = new Map();
    this.phase = 'waiting';   // waiting | play | over
    /** @type {Array<null|{id:number,type:string,side:number}>} */
    this.cells = new Array(CFG.cols * CFG.rows).fill(null);
    this.nextPieceId = 1;
    this.turn = null;         // playerId
    this.plies = 0;           // 总步数
    this.idlePly = 0;         // 距离上一次吃子过了几手
    this.noCapPly = 0;        // 双方都吃不到子的连续手数
    this.lastMove = null;
    this.log = [];
    this.chat = [];
    this.winnerSide = null;   // 0 / 1 / null(平局)
    this.winReason = '';
  }

  addPlayer(id) {
    const side = this.order.length === 0 ? 0 : 1;
    this.players.set(id, { id, ws: null });
    this.order.push(id);
    this.sideOf.set(id, side);
    return this.players.get(id);
  }

  isEmpty() {
    return this.players.size === 0;
  }

  aliveCount(side) {
    let n = 0;
    for (const cell of this.cells) if (cell && cell.side === side) n++;
    return n;
  }

  countByType(side) {
    const out = { R: 0, S: 0, P: 0 };
    for (const cell of this.cells) if (cell && cell.side === side) out[cell.type]++;
    return out;
  }
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function at(room, r, c) {
  if (!inBounds(r, c)) return null;
  return room.cells[idx(r, c)];
}

function pushLog(room, text) {
  room.log.push({ t: Date.now(), text });
  if (room.log.length > 60) room.log.splice(0, room.log.length - 60);
}

/* ---------------- 开局布阵 ---------------- */

/** 每人一副棋子：3 石头 3 剪刀 3 布 + 随机 1 枚；棋盘太小就均衡地少放几枚 */
function pieceTypeList() {
  const list = [];
  for (let i = 0; i < CFG.basePerType; i++) for (const t of TYPES) list.push(t);
  for (let i = 0; i < CFG.extraRandom; i++) list.push(TYPES[Math.floor(Math.random() * 3)]);

  const cap = CFG.piecesPerPlayer;
  if (list.length <= cap) return list;

  const out = [];
  for (let i = 0; i < CFG.basePerType && out.length < cap; i++) {
    for (const t of TYPES) {
      if (out.length >= cap) break;
      out.push(t);
    }
  }
  while (out.length < cap) out.push(TYPES[Math.floor(Math.random() * 3)]);
  return out;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 把棋子随机撒在双方各自靠边的几行里 */
function placePieces(room) {
  room.cells = new Array(CFG.cols * CFG.rows).fill(null);
  room.nextPieceId = 1;

  /** 某一方主场的全部格子，打乱过（pop 就是从随机位置取） */
  const homeCells = (side) => {
    const out = [];
    const [a, b] = homeRowRange(side);
    for (let r = a; r <= b; r++) for (let c = 0; c < CFG.cols; c++) out.push([r, c]);
    return shuffle(out);
  };

  if (CFG.mirror) {
    // 镜像模式：两边布局完全对称（想要绝对公平时开这个）
    const top = homeCells(0);
    for (const type of pieceTypeList()) {
      const t = top.pop();
      if (!t) break;
      const m = [CFG.rows - 1 - t[0], CFG.cols - 1 - t[1]];
      room.cells[idx(t[0], t[1])] = { id: room.nextPieceId++, type, side: 0 };
      room.cells[idx(m[0], m[1])] = { id: room.nextPieceId++, type, side: 1 };
    }
    return;
  }

  // 默认：两边各撒各的，互不相同；那枚随机棋子也各随机各的
  for (const side of [0, 1]) {
    const spots = homeCells(side);
    for (const type of pieceTypeList()) {
      const spot = spots.pop();
      if (!spot) break;
      room.cells[idx(spot[0], spot[1])] = { id: room.nextPieceId++, type, side };
    }
  }
}

/* ---------------- 走子 ---------------- */

/**
 * 从 (r0,c0) 出发能落到哪些格子。
 * 空位可以落脚也可以继续走；能克制的敌子可以落脚（吃掉它）但不能穿过；
 * 吃不动 / 自己的棋子直接挡路。
 */
function targetsFrom(room, r0, c0) {
  const me = at(room, r0, c0);
  if (!me) return [];
  const found = new Map();          // key -> {r,c,cap,d}
  const dist = new Map();           // 走到的空位 -> 最短步数
  dist.set(idx(r0, c0), 0);
  const queue = [[r0, c0, 0]];

  while (queue.length) {
    const [r, c, d] = queue.shift();
    if (d >= CFG.stepMax) continue;
    for (const [dr, dc] of DIRS) {
      const nr = r + dr;
      const nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const cell = at(room, nr, nc);
      if (!cell) {
        const k = idx(nr, nc);
        if (dist.has(k)) continue;
        dist.set(k, d + 1);
        found.set(k, { r: nr, c: nc, cap: false, d: d + 1 });
        queue.push([nr, nc, d + 1]);
      } else if (cell.side !== me.side && beats(me.type, cell.type)) {
        found.set(idx(nr, nc), { r: nr, c: nc, cap: true, d: d + 1 });
      }
      // 其它情况：自己人 或 吃不动的敌人 —— 挡路
    }
  }
  return [...found.values()].sort((a, b) => a.d - b.d || a.r - b.r || a.c - b.c);
}

/** 某一方所有棋子的可走位置（前端直接用它来画提示点） */
function movesFor(room, side) {
  const out = [];
  for (let r = 0; r < CFG.rows; r++) {
    for (let c = 0; c < CFG.cols; c++) {
      const p = at(room, r, c);
      if (!p || p.side !== side) continue;
      const targets = targetsFrom(room, r, c);
      if (targets.length) out.push({ id: p.id, r, c, type: p.type, targets });
    }
  }
  return out;
}

function hasCapture(room, side) {
  for (let r = 0; r < CFG.rows; r++) {
    for (let c = 0; c < CFG.cols; c++) {
      const p = at(room, r, c);
      if (!p || p.side !== side) continue;
      if (targetsFrom(room, r, c).some((t) => t.cap)) return true;
    }
  }
  return false;
}

function canMove(room, side) {
  for (let r = 0; r < CFG.rows; r++) {
    for (let c = 0; c < CFG.cols; c++) {
      const p = at(room, r, c);
      if (!p || p.side !== side) continue;
      if (targetsFrom(room, r, c).length) return true;
    }
  }
  return false;
}

function startPlay(room) {
  placePieces(room);
  room.phase = 'play';
  room.plies = 0;
  room.idlePly = 0;
  room.noCapPly = 0;
  room.lastMove = null;
  room.log = [];
  room.winnerSide = null;
  room.winReason = '';
  room.turn = room.order[Math.random() < 0.5 ? 0 : 1];
  pushLog(room, `开局：每人 ${CFG.piecesPerPlayer} 枚棋子，随机布阵完成`);
  pushLog(room, `${sideName(room.sideOf.get(room.turn))} 先行`);
  skipIfStuck(room);
  checkEnd(room);
  return room;
}

/** 轮到的一方要是完全动不了，就自动跳过（正常打不出来，留作保险） */
function skipIfStuck(room) {
  for (let guard = 0; guard < 4; guard++) {
    if (room.phase !== 'play' || !room.turn) return;
    if (canMove(room, room.sideOf.get(room.turn))) return;
    pushLog(room, `${sideName(room.sideOf.get(room.turn))} 无子可动，跳过`);
    room.turn = otherPlayerId(room, room.turn);
    if (!room.turn) return;
  }
}

function otherPlayerId(room, playerId) {
  const side = room.sideOf.get(playerId);
  for (const [id, s] of room.sideOf) if (s === otherSide(side)) return id;
  return null;
}

function finish(room, winnerSide, reason) {
  room.phase = 'over';
  room.winnerSide = winnerSide;
  room.winReason = reason;
  pushLog(room, winnerSide === null ? `平局：${reason}` : `${sideName(winnerSide)} 获胜：${reason}`);
}

function finishByCount(room, reason) {
  const a = room.aliveCount(0);
  const b = room.aliveCount(1);
  if (a === b) return finish(room, null, `${reason}，双方各剩 ${a} 枚`);
  return finish(room, a > b ? 0 : 1, `${reason}，${a} : ${b} 比数量`);
}

/** 结算检查：缺类型 / 吃光了 / 双方都吃不到子了 / 太久没吃子 */
function checkEnd(room) {
  const alive = [room.aliveCount(0), room.aliveCount(1)];
  const wiped = alive[0] === 0 || alive[1] === 0;
  if (wiped) {
    if (alive[0] === 0 && alive[1] === 0) return finish(room, null, '同归于尽');
    const w = alive[0] === 0 ? 1 : 0;
    return finish(room, w, '吃光了对方的棋子');
  }
  // 核心规则：石头剪刀布三种棋子必须齐全，缺任何一种就输
  for (const side of [0, 1]) {
    const c = room.countByType(side);
    const missing = TYPES.filter((t) => c[t] === 0);
    if (missing.length) {
      const names = missing.map((t) => NAMES[t]).join('、');
      return finish(room, otherSide(side), `你的${names}被吃光了`);
    }
  }
  // 双方都吃不到子，还要再撑 noCapGrace 手才结算 ——
  // 否则「刚好吃不到」的瞬间就结束，落后的一方连摆阵型追回来的机会都没有。
  if (!hasCapture(room, 0) && !hasCapture(room, 1)) {
    room.noCapPly++;
    if (room.noCapPly >= CFG.noCapGrace) {
      return finishByCount(room, `连续 ${CFG.noCapGrace} 手双方都吃不到子`);
    }
  } else {
    room.noCapPly = 0;
  }
  if (room.idlePly >= CFG.idleSettle) {
    return finishByCount(room, `连续 ${CFG.idleSettle} 手没有吃子`);
  }
  return false;
}

/** 校验一次走子。path = [[r,c], ...]，含起点，长度 2 ~ stepMax+1。 */
function validateMove(room, side, path) {
  if (room.phase !== 'play') return { error: '对局还没开始' };
  const steps = Array.isArray(path) ? path.length - 1 : 0;
  if (!Array.isArray(path) || steps < 1) return { error: '至少要往前走一格' };
  if (steps > CFG.stepMax) return { error: `一次最多走 ${CFG.stepMax} 格` };
  const pts = [];
  for (const p of path) {
    if (!Array.isArray(p) || p.length < 2) return { error: '走位不合法' };
    const r = Number(p[0]);
    const c = Number(p[1]);
    if (!Number.isInteger(r) || !Number.isInteger(c) || !inBounds(r, c)) return { error: '走位不合法' };
    pts.push([r, c]);
  }
  for (let i = 1; i < pts.length; i++) {
    const d = Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
    if (d !== 1) return { error: '只能一格一格地上下左右走' };
  }
  const from = pts[0];
  const to = pts[pts.length - 1];
  const me = at(room, from[0], from[1]);
  if (!me || me.side !== side) return { error: '那不是你的棋子' };
  // 中间站必须有空
  for (let i = 1; i < pts.length - 1; i++) {
    if (at(room, pts[i][0], pts[i][1])) return { error: '路上有棋子挡着' };
  }
  const dest = at(room, to[0], to[1]);
  if (dest) {
    if (dest.side === side) return { error: '不能压在自己的棋子上' };
    if (!beats(me.type, dest.type)) {
      return { error: `${NAMES[me.type]}吃不了${NAMES[dest.type]}` };
    }
  }
  return { pts, from, to, me, dest };
}

function handleMove(room, playerId, path) {
  if (!room.sideOf.has(playerId)) return { ok: false, error: '你不在这个房间里' };
  if (room.turn !== playerId) return { ok: false, error: '还没轮到你走' };
  const side = room.sideOf.get(playerId);

  const v = validateMove(room, side, path);
  if (v.error) return { ok: false, error: v.error };

  room.cells[idx(v.from[0], v.from[1])] = null;
  let captured = null;
  if (v.dest) {
    captured = { id: v.dest.id, type: v.dest.type, side: v.dest.side, r: v.to[0], c: v.to[1] };
  }
  room.cells[idx(v.to[0], v.to[1])] = v.me;

  room.plies++;
  room.idlePly = captured ? 0 : room.idlePly + 1;
  room.lastMove = {
    side,
    from: v.from,
    to: v.to,
    path: v.pts,
    type: v.me.type,
    capture: captured,
  };
  pushLog(
    room,
    `${sideName(side)} ${NAMES[v.me.type]} ${coord(v.from[0], v.from[1])}→${coord(v.to[0], v.to[1])}` +
      (captured ? ` 吃掉了${NAMES[captured.type]}` : '')
  );

  if (checkEnd(room)) return { ok: true };

  room.turn = otherPlayerId(room, playerId);
  skipIfStuck(room);
  return { ok: true };
}

function handleChat(room, playerId, text) {
  if (!room.sideOf.has(playerId)) return { ok: false, error: '你不在这个房间里' };
  const t = String(text == null ? '' : text).trim().slice(0, 120);
  if (!t) return { ok: false, error: '说点什么吧' };
  room.chat.push({ side: room.sideOf.get(playerId), text: t, t: Date.now() });
  if (room.chat.length > 50) room.chat.splice(0, room.chat.length - 50);
  return { ok: true };
}

/* ---------------- 给前端的视图 ---------------- */

function boardList(room) {
  const out = [];
  for (let r = 0; r < CFG.rows; r++) {
    for (let c = 0; c < CFG.cols; c++) {
      const p = at(room, r, c);
      if (p) out.push({ id: p.id, r, c, type: p.type, side: p.side });
    }
  }
  return out;
}

function viewFor(room, playerId) {
  const side = room.sideOf.has(playerId) ? room.sideOf.get(playerId) : null;
  const myTurn = room.phase === 'play' && room.turn === playerId;
  return {
    type: 'state',
    room: room.id,
    cfg: {
      cols: CFG.cols,
      rows: CFG.rows,
      homeRows: CFG.homeRows,
      stepMax: CFG.stepMax,
      piecesPerPlayer: CFG.piecesPerPlayer,
      idleSettle: CFG.idleSettle,
      noCapGrace: CFG.noCapGrace,
    },
    phase: room.phase,
    players: room.players.size,
    youSide: side,
    turnSide: room.turn ? room.sideOf.get(room.turn) : null,
    myTurn,
    board: boardList(room),
    counts: [room.countByType(0), room.countByType(1)],
    alive: [room.aliveCount(0), room.aliveCount(1)],
    // 只有轮到你时才下发可走位置
    moves: myTurn ? movesFor(room, side) : [],
    canCapture: [hasCapture(room, 0), hasCapture(room, 1)],
    plies: room.plies,
    idlePly: room.idlePly,
    noCapPly: room.noCapPly,
    lastMove: room.lastMove,
    log: room.log,
    chat: room.chat,
    winnerSide: room.phase === 'over' ? room.winnerSide : null,
    winReason: room.phase === 'over' ? room.winReason : '',
    over: room.phase === 'over',
  };
}

module.exports = {
  CFG,
  TYPES,
  NAMES,
  ICONS,
  BEATS,
  DIRS,
  Room,
  uid,
  beats,
  at,
  idx,
  inBounds,
  otherSide,
  sideName,
  homeRowRange,
  isHome,
  placePieces,
  targetsFrom,
  movesFor,
  hasCapture,
  canMove,
  startPlay,
  validateMove,
  handleMove,
  handleChat,
  checkEnd,
  viewFor,
  pushLog,
};
