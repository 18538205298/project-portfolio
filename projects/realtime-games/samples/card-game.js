'use strict';

/**
 * 宠物卡牌对战 —— 纯规则层（不含任何网络 / IO）
 *
 * server.js 负责连接与广播，本文件只负责规则，因此可以被单元测试直接驱动。
 */

const MAX_PLAYERS = 2;
const HAND_LIMIT = 4;
const START_HAND = 4;
// 每人能带几只宠物（选宠阶段每人各挑这么多只）。想改局制改这一个数就行。
const PETS_PER_PLAYER = 3;
const FREEZE_NEED = 2;   // 寒霜雪貂：连续命中几次可以冻结对手
const VALOR_ROUNDS = 2;  // 战意狂狮：进入战意后持续几个回合
const KILL_HEAL = 3;     // 噬魂骨犬：每击杀一只对方宠物回多少血
const KILL_HEAL_MAX = 2; // 噬魂骨犬：每击杀一只对方宠物，血量上限 +多少
const SKILL_COST = 2;    // 换命巫祝：技能需要几张「1 攻击」

// ---------------------------------------------------------------- 卡牌
const CARDS = {
  ATK1:    { key: 'ATK1',    name: '1 攻击', type: 'attack',  dmg: 1 },
  ATK2:    { key: 'ATK2',    name: '2 攻击', type: 'attack',  dmg: 2 },
  ATK3:    { key: 'ATK3',    name: '3 攻击', type: 'attack',  dmg: 3 },
  REFLECT: { key: 'REFLECT', name: '反弹',   type: 'reflect' },
  HEAL:    { key: 'HEAL',    name: '加血',   type: 'heal',    heal: 3 },
};

const CARD_ORDER = ['ATK1', 'ATK2', 'ATK3', 'REFLECT', 'HEAL'];

const DECK_RECIPE = [
  ['ATK1', 10], ['ATK2', 17], ['ATK3', 17], ['REFLECT', 10], ['HEAL', 10],
];

// ---------------------------------------------------------------- 宠物
const PETS = [
  { id: 'wolf',  name: '嗜血狼王', hp: 12, trait: 'lifesteal',   desc: '攻击命中后回复 1 血' },
  { id: 'fox',   name: '镜影玄狐', hp: 10, trait: 'atk1_reflect', desc: '打出「1 攻击」时视为打出「反弹」' },
  { id: 'deer',  name: '慈愈灵鹿', hp: 10, trait: 'heal_bench',  desc: '加血时，场下血量最低的队友额外回复 2 血' },
  { id: 'guard', name: '荆棘铁卫', hp: 12, trait: 'thorns',      desc: '被攻击后对攻击者造成 1 点伤害' },
  { id: 'sword', name: '轻云剑客', hp: 14, trait: 'atk1_heal',   desc: '每次打出「1 攻击」回复 1 血' },
  { id: 'ranger', name: '破镜游侠', hp: 14, trait: 'pierce',     desc: '「1 攻击」可以穿透反弹' },
  { id: 'quake',  name: '裂地蛮牛', hp: 14, trait: 'splash',     desc: '攻击命中后，对手场下血量最低的那只也受 1 点伤害' },

  // ---- 第二批：会改变出牌方式的宠物 ----
  { id: 'monkey', name: '千手灵猴', hp: 10, trait: 'multi',
    desc: `可以一次打出多张相同的牌：每多 1 张效果 +1（被反弹时按总伤害挨打）` },
  { id: 'witch',  name: '换命巫祝', hp: 10, trait: 'skill_hpswap',
    desc: `技能：弃 ${SKILL_COST} 张「1 攻击」，本回合结算后与对手交换出战宠血量` },
  { id: 'frost',  name: '寒霜雪貂', hp: 10, trait: 'freeze',
    desc: `连续 ${FREEZE_NEED} 次攻击命中即冻结对手，对方下回合什么都做不了` },
  { id: 'eagle',  name: '断罪雷鹰', hp: 12, trait: 'reflect_punish',
    desc: '对手每次打出「反弹」，其出战宠受到 1 点伤害' },
  { id: 'lion',   name: '战意狂狮', hp: 12, trait: 'valor',
    desc: '没有战意时攻击 → 接下来 2 回合进入战意；战意状态下攻击额外回复 1 血' },
  { id: 'hound',  name: '噬魂骨犬', hp: 10, trait: 'kill_heal',
    desc: '自己攻击击杀对方出战宠时，血量上限 +2、当前血量 +3' },
];

const getPetDef = (id) => PETS.find((p) => p.id === id);

// ---------------------------------------------------------------- 工具
const uid = () => Math.random().toString(36).slice(2, 10);

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makePet(def) {
  return {
    defId: def.id,
    name: def.name,
    trait: def.trait,
    desc: def.desc,
    maxHp: def.hp,
    hp: def.hp,
    alive: true,
    hits: 0,    // 寒霜雪貂：连续命中次数（印记）
    valor: 0,   // 战意狂狮：战意状态剩余回合数（>0 表示有战意）
  };
}

function buildDeck() {
  const d = [];
  for (const [key, n] of DECK_RECIPE) {
    for (let i = 0; i < n; i++) d.push(key);
  }
  return shuffle(d);
}

const activePet = (p) => p.pets[p.activeIdx];
const benchIndex = (p) => p.pets.findIndex((pt, i) => i !== p.activeIdx && pt.alive);
/** 场上所有「活着的场下宠物」的下标 */
const benchList = (p) => p.pets.map((pt, i) => i).filter((i) => i !== p.activeIdx && p.pets[i].alive);
/** 场下血量最低的那只（血量相同就取靠前的）。波及 / 场下加血都用它。 */
function benchLowest(p) {
  let best = -1;
  for (const i of benchList(p)) {
    if (best < 0 || p.pets[i].hp < p.pets[best].hp) best = i;
  }
  return best;
}
const totalHp = (p) => p.pets.filter((pt) => pt.alive).reduce((s, pt) => s + pt.hp, 0);
const sortHand = (h) => [...h].sort((a, b) => CARD_ORDER.indexOf(a) - CARD_ORDER.indexOf(b));

// ---------------------------------------------------------------- 房间
class Room {
  constructor(id) {
    this.id = id;
    this.players = new Map();
    this.order = [];
    this.phase = 'waiting'; // waiting | draft | battle | over
    // 牌堆/弃牌堆是「每人一副」的，放在玩家身上（addPlayer 里初始化）
    this.round = 0;
    this.log = [];
    this.winner = null;
    this.winReason = '';
    this.draft = null;
    this.reveal = null;     // 上一回合双方出的牌（前端揭晓动画用）
    this.revealing = false; // 双方都已出牌、等待揭晓
    this.chat = [];         // 对局内发言记录（保留最近若干条）
  }

  addPlayer(id) {
    const label = this.order.length === 0 ? '玩家一' : '玩家二';
    const player = {
      id, label, ws: null,
      hand: [], pets: [], activeIdx: 0, pending: null,
      deck: [],             // 自己的牌堆（每人一副，互不影响）
      discard: [],          // 自己打出去的牌，牌堆抽空后洗回来
      lastDrawn: null,
      drawn: [],            // 本回合摸到的所有牌（多张牌宠物可能一次摸好几张）
      frozen: false,        // 被寒霜雪貂冻结：什么都做不了，受伤才苏醒
      mustPick: false,      // 出战宠阵亡后还有 2 只场下可选：可以让玩家自己挑一只换上来
      chosenActive: null,   // 自己选的出战宠物
      handUids: [],         // 与 hand 一一对应的唯一 id，供前端做位移/顺序动画
      chatTimes: [],        // 发言时间戳，用于限流
    };
    this.players.set(id, player);
    this.order.push(id);
    return player;
  }

  opponentOf(playerId) {
    const other = this.order.find((id) => id !== playerId);
    return other ? this.players.get(other) : null;
  }

  isEmpty() { return this.players.size === 0; }
}

// ---------------------------------------------------------------- 选宠
function startDraft(room) {
  room.phase = 'draft';
  // 由谁先选宠物是随机的，不固定是建房的人
  const startIdx = Math.random() < 0.5 ? 0 : 1;
  room.draft = { pool: shuffle(PETS), picks: [], turn: 0, startIdx };
  const first = room.players.get(room.order[startIdx]);
  room.log = [{ kind: 'info', text: `随机决定：${first ? first.label : ''} 先选宠物` }];
}

/** 当前该谁选（先选方由 startIdx 随机决定） */
const draftTurnId = (room) => room.order[(room.draft.startIdx + room.draft.turn) % 2];

function handlePick(room, playerId, petId) {
  if (room.phase !== 'draft' || !room.draft) return { ok: false, error: '当前不是选宠阶段' };
  const turnId = draftTurnId(room);
  if (turnId !== playerId) return { ok: false, error: '还没轮到你选' };

  const idx = room.draft.pool.findIndex((d) => d.id === petId);
  if (idx < 0) return { ok: false, error: '这只宠物已经被选走了' };

  const def = room.draft.pool.splice(idx, 1)[0];
  const p = room.players.get(playerId);
  p.pets.push(makePet(def));
  room.draft.picks.push({ playerId, petId: def.id, petName: def.name });
  room.draft.turn++;

  // 名额选满（或者池子被选空）就进入下一步，避免把 PETS_PER_PLAYER 调大后卡在选宠阶段
  if (room.draft.picks.length >= MAX_PLAYERS * PETS_PER_PLAYER || room.draft.pool.length === 0) {
    startChoose(room);
  }
  return { ok: true };
}

// ---------------------------------------------------------------- 自选出战宠物
/** 选宠结束后，双方各自指定哪只先出战（而不是固定先选的那只） */
function startChoose(room) {
  room.phase = 'choose';
  room.choose = { picked: {} };
  room.log = [{ kind: 'info', text: '请选择先出战的宠物' }];
}

function handleChoose(room, playerId, idx) {
  if (room.phase !== 'choose' || !room.choose) return { ok: false, error: '当前不是选择出战宠物阶段' };
  const p = room.players.get(playerId);
  if (!p) return { ok: false, error: '玩家不存在' };
  const i = Number(idx);
  if (!Number.isInteger(i) || i < 0 || i >= p.pets.length) return { ok: false, error: '无效的宠物' };

  room.choose.picked[playerId] = i;
  p.chosenActive = i;

  // 双方都选好才开打
  if (Object.keys(room.choose.picked).length >= MAX_PLAYERS) startBattle(room);
  return { ok: true };
}

// ---------------------------------------------------------------- 开局
function startBattle(room) {
  room.phase = 'battle';
  room.round = 1;
  room.winner = null;
  room.winReason = '';
  room.reveal = null;
  room.revealing = false;

  for (const p of room.players.values()) {
    // 每人一副独立的牌堆，每种牌各 5 张：不会因为对手把某种牌摸光而摸不到
    p.deck = buildDeck();
    p.discard = [];
    p.pets.forEach((pt) => {
      pt.hp = pt.maxHp; pt.alive = true; pt.hits = 0; pt.valor = 0;
    });
    // 出战位用玩家自己选的；没选就退回第一只
    p.activeIdx = (typeof p.chosenActive === 'number' && p.pets[p.chosenActive])
      ? p.chosenActive : 0;
    p.hand = [];
    p.handUids = [];
    for (let i = 0; i < START_HAND; i++) {
      const c = p.deck.pop();
      if (c) { p.hand.push(c); p.handUids.push(uid()); }
    }
    p.pending = null;
    p.lastDrawn = null;
    p.drawn = [];
    p.frozen = false;
    p.mustPick = false;
  }
  room.log = [{ kind: 'info', text: '对战开始！' }];
}

/** 摸一张牌，返回摸到的牌。自己的牌堆抽空时把自己的弃牌堆洗回来继续用 */
function draw(room, p) {
  if (p.hand.length >= HAND_LIMIT) return { card: null, reshuffled: false };

  let reshuffled = false;
  if (p.deck.length === 0 && p.discard.length > 0) {
    // 手上留着的牌不参与重洗，只把「已经打出去」的牌重新洗成牌堆
    p.deck = shuffle(p.discard);
    p.discard = [];
    reshuffled = true;
  }

  const c = p.deck.pop();
  if (!c) return { card: null, reshuffled };
  p.hand.push(c);
  if (!Array.isArray(p.handUids)) p.handUids = [];
  p.handUids.push(uid());
  return { card: c, reshuffled };
}

/** 某人的牌是不是彻底用光了（牌堆 + 弃牌堆 + 手牌全空） */
const noCards = (p) => p.deck.length === 0 && p.discard.length === 0 && p.hand.length === 0;

// ---------------------------------------------------------------- 行动
/** 当前出战宠是否拥有「换血」技能 */
const hasSkill = (p) => {
  const pet = activePet(p);
  return !!pet && pet.trait === 'skill_hpswap';
};
const skillReady = (p) => hasSkill(p) && p.hand.filter((k) => k === 'ATK1').length >= SKILL_COST;

function handleAction(room, playerId, action) {
  if (room.phase !== 'battle') return { ok: false, error: '对局尚未开始' };
  const p = room.players.get(playerId);
  if (!p) return { ok: false, error: '玩家不存在' };
  // 被冻结：什么都不能做，只能等对手打醒你
  if (p.frozen) return { ok: false, error: '你被冻结了，本回合无法行动' };
  if (p.pending) return { ok: false, error: '本回合已经提交过了' };

  const me = activePet(p);

  if (action.type === 'card') {
    // 允许 cards 数组（多张同名卡）；老的单张写法 card 也继续支持
    let list = Array.isArray(action.cards) ? action.cards.slice() : null;
    if (!list) {
      const one = action.card;
      const cnt = Math.max(1, Math.min(HAND_LIMIT, Number(action.count) || 1));
      list = one ? new Array(cnt).fill(one) : [];
    }
    if (!list.length) return { ok: false, error: '无效的卡牌' };
    if (list.length > HAND_LIMIT) return { ok: false, error: '一次最多打出 4 张' };

    const key = list[0];
    if (!CARDS[key]) return { ok: false, error: '无效的卡牌' };
    if (list.some((k) => k !== key)) return { ok: false, error: '一次只能打出相同的牌' };
    if (list.length > p.hand.filter((k) => k === key).length) {
      return { ok: false, error: '手上的这张牌不够' };
    }
    if (list.length > 1 && me.trait !== 'multi') {
      return { ok: false, error: `只有${getPetDef('monkey').name}能一次打出多张牌` };
    }
    p.pending = { type: 'card', card: key, count: list.length };
  } else if (action.type === 'skill') {
    if (!hasSkill(p)) return { ok: false, error: '当前出战宠物没有技能' };
    if (!skillReady(p)) return { ok: false, error: `需要 ${SKILL_COST} 张「1 攻击」才能发动技能` };
    p.pending = { type: 'skill' };
  } else if (action.type === 'switch') {
    const list = benchList(p);
    if (!list.length) return { ok: false, error: '没有可以替换的宠物' };
    // 可以指定换上哪一只（3 只宠物时场下有 2 只）；不指定就换第一只
    const want = Number(action.idx);
    const idx = Number.isInteger(want) && list.includes(want) ? want : list[0];
    p.pending = { type: 'switch', idx };
  } else if (action.type === 'pass') {
    p.pending = { type: 'pass' };
  } else {
    return { ok: false, error: '未知操作' };
  }
  return { ok: true };
}

/**
 * 出战宠阵亡后，如果场下还有 2 只活着，玩家可以自己挑一只换上来（不消耗行动）。
 * 只能在「刚阵亡、还没进入下一回合结算」这段窗口里用一次。
 */
function handlePickSub(room, playerId, idx) {
  if (room.phase !== 'battle') return { ok: false, error: '对局尚未开始' };
  const p = room.players.get(playerId);
  if (!p) return { ok: false, error: '玩家不存在' };
  if (!p.mustPick) return { ok: false, error: '现在不需要选择上场的宠物' };
  const i = Number(idx);
  // 阵亡换宠时，弹窗里列出的是「剩下的全部宠物」（含自动顶上的那只），所以允许选当前出战位
  if (!Number.isInteger(i) || !p.pets[i] || !p.pets[i].alive) return { ok: false, error: '无效的宠物' };
  p.activeIdx = i;
  p.mustPick = false;
  return { ok: true };
}

function handleCancel(room, playerId) {  if (room.phase !== 'battle') return { ok: false };
  const p = room.players.get(playerId);
  if (!p) return { ok: false };
  if (p.frozen) return { ok: false };
  p.pending = null;
  return { ok: true };
}

/** 被冻结的一方没有 pending，但也算「这个回合已经结束了行动」 */
const pendingOf = (p) => p.pending || (p.frozen ? { type: 'freeze' } : null);

const bothReady = (room) => {
  if (room.phase !== 'battle') return false;
  const ps = [...room.players.values()];
  return ps.length === MAX_PLAYERS && ps.every((p) => pendingOf(p));
};

/**
 * 回合结算。顺序：
 *  1) 换宠物先落地（之后再吃攻击）
 *  2) 判定有效动作（镜影玄狐把「1 攻击」变成「反弹」；千手灵猴叠加同名卡）
 *  3) 收集本回合所有血量变化，最后一次性「净额结算」
 *     —— 加血与受伤同时发生，不能被上限先把加血吃掉
 *  4) 换命巫祝的技能：净额结算之后、判定阵亡之前交换双方出战宠的血量
 *  5) 解冻 / 冻结 / 连续攻击计数
 *  6) 死亡与强制换宠
 *  7) 出牌消耗与摸牌
 *  8) 胜负判定
 */
function resolveRound(room) {
  const [a, b] = room.order.map((id) => room.players.get(id));
  const ev = [];
  const playedRound = room.round; // 递增前先记住这是第几回合

  // 本回合各方提交了什么。被冻结的一方没有 pending，但同样要占掉这个回合。
  const acts = new Map();
  for (const p of [a, b]) {
    acts.set(p.id, p.pending || (p.frozen ? { type: 'freeze' } : { type: 'pass' }));
    p.mustPick = false;   // 「阵亡后自选替补」的窗口只到这一回合开始为止
  }
  const actOf = (p) => acts.get(p.id);

  // 1) 换宠物先结算
  for (const p of [a, b]) {
    const act = actOf(p);
    if (act.type === 'switch') {
      const list = benchList(p);
      const want = Number(act.idx);
      const bi = Number.isInteger(want) && list.includes(want) ? want : list[0];
      if (bi != null && bi >= 0) {
        p.activeIdx = bi;
        ev.push({ kind: 'switch', who: p.id, pet: activePet(p).name });
      }
    }
  }

  // 主动换宠已经落地、但「阵亡强制换宠」还没发生时的快照。
  // 前端先用它渲染「谁在挨打」，播完阵亡动画再切到新宠物；
  // beforeHp 让血条从「本回合开始时的血量」滑到新值（比前端反推更准），
  // 同时也是「本回合有没有掉血」的判断依据（解冻用）。
  const beforeActiveIdx = {};
  const beforeHp = {};
  for (const p of [a, b]) {
    beforeActiveIdx[p.id] = p.activeIdx;
    beforeHp[p.id] = p.pets.map((pt) => pt.hp);
  }

  // 2) 有效动作
  const eff = new Map();
  for (const p of [a, b]) {
    const act = actOf(p);
    const me = activePet(p);
    if (act.type === 'card') {
      const c = CARDS[act.card];
      const n = Math.max(1, Math.min(HAND_LIMIT, Number(act.count) || 1));
      if (act.card === 'ATK1' && me.trait === 'atk1_reflect') {
        eff.set(p.id, { type: 'reflect', card: act.card, n, extra: n - 1 });
        ev.push({ kind: 'trait_reflect', who: p.id, pet: me.name });
      } else {
        const e = { type: c.type, card: act.card, n };
        // 千手灵猴：多打 1 张，效果 +1
        if (c.type === 'attack') e.dmg = c.dmg + (n - 1);
        if (c.type === 'heal') e.heal = c.heal + (n - 1);
        if (c.type === 'reflect') e.extra = n - 1;
        eff.set(p.id, e);
        if (n > 1) ev.push({ kind: 'trait_multi', who: p.id, pet: me.name, card: act.card, n });
      }
    } else if (act.type === 'skill') {
      eff.set(p.id, { type: 'skill' });
    } else if (act.type === 'switch') {
      eff.set(p.id, { type: 'switch' });
    } else if (act.type === 'freeze') {
      eff.set(p.id, { type: 'freeze' });
    } else {
      eff.set(p.id, { type: 'pass' });
    }
  }

  /* 3) 先把本回合所有血量变化「记账」，最后一次性净额结算。
     加血与受伤是同时发生的：如果先加血，会被上限吃掉，
     就会出现「满血加血失效、随后又挨 3 点」这种不合理结果。
     正确做法是 (当前血 + 加血 − 受伤) 之后再夹到 [0, 上限]。 */
  const delta = new Map();
  const addHp = (pet, heal, dmg) => {
    const cur = delta.get(pet) || { heal: 0, dmg: 0 };
    cur.heal += heal;
    cur.dmg += dmg;
    delta.set(pet, cur);
  };

  // 3a) 加血卡
  for (const p of [a, b]) {
    const e = eff.get(p.id);
    if (e.type !== 'heal') continue;
    const me = activePet(p);
    addHp(me, e.heal, 0);
    if (me.trait === 'heal_bench') {
      // 慈愈灵鹿：场下血量最低的那只也回 2 血
      const bi = benchLowest(p);
      if (bi >= 0) addHp(p.pets[bi], 2, 0);
    }
  }

  // 3b) 攻击 / 反弹 / 荆棘 / 波及 / 吸血（全部只记账，不直接改血）
  const dmgQueue = [];
  for (const p of [a, b]) {
    const e = eff.get(p.id);
    if (e.type !== 'attack') continue;
    const foe = p === a ? b : a;
    const attackerPet = activePet(p);
    const dmg = e.dmg;
    const foeEff = eff.get(foe.id);

    // 破镜游侠：打出「1 攻击」时可以穿透反弹
    const piercing = attackerPet.trait === 'pierce' && e.card === 'ATK1';

    if (foeEff.type === 'reflect' && !piercing) {
      // 被反弹：伤害回到攻击方自己身上。对方多打几张反弹，就再多弹几点回来。
      dmgQueue.push({
        victim: p, victimPet: attackerPet, attacker: p, attackerPet,
        dmg: dmg + (foeEff.extra || 0), reflected: true,
      });
    } else {
      if (foeEff.type === 'reflect' && piercing) {
        ev.push({ kind: 'trait_pierce', who: p.id, pet: attackerPet.name });
      }
      dmgQueue.push({ victim: foe, victimPet: activePet(foe), attacker: p, attackerPet, dmg, reflected: false });
    }
  }

  for (const d of dmgQueue) {
    addHp(d.victimPet, 0, d.dmg);
    if (d.reflected) continue; // 被反弹不算「命中」，不触发荆棘 / 吸血 / 波及
    d.landed = true;

    if (d.victimPet.trait === 'thorns') {
      d.thorns = true;
      addHp(d.attackerPet, 0, 1);
    }
    if (d.attackerPet.trait === 'lifesteal') {
      d.lifesteal = true;
      addHp(d.attackerPet, 1, 0);
    }
    // 裂地蛮牛：命中后，对手场下血量最低的那只也被波及 1 点
    if (d.attackerPet.trait === 'splash') {
      const bi = benchLowest(d.victim);
      if (bi >= 0) {
        d.splashPet = d.victim.pets[bi];
        addHp(d.splashPet, 0, 1);
      }
    }
  }

  // 断罪雷鹰：对手打出「反弹」→ 对手出战宠直接吃 1 点
  const punishes = [];
  for (const p of [a, b]) {
    const me = activePet(p);
    if (me.trait !== 'reflect_punish') continue;
    const foe = p === a ? b : a;
    if (eff.get(foe.id).type !== 'reflect') continue;
    const foePet = activePet(foe);
    addHp(foePet, 0, 1);
    punishes.push({ who: foe.id, pet: foePet.name, amount: 1 });
  }

  // 轻云剑客 / 战意狂狮 / 寒霜雪貂 的特性计数
  const valorHeals = [];
  const valorOn = [];
  const willFreeze = [];
  for (const p of [a, b]) {
    const e = eff.get(p.id);
    const me = activePet(p);
    const foe = p === a ? b : a;
    if (e.type === 'attack') {
      // 轻云剑客：打出「1 攻击」回 1 血（不论是否被反弹）
      if (me.trait === 'atk1_heal' && e.card === 'ATK1') addHp(me, 1, 0);
      // 战意狂狮：没有战意时攻击 → 开启 2 回合战意；有战意时攻击 → 回 1 血
      if (me.trait === 'valor') {
        if ((me.valor || 0) > 0) {
          addHp(me, 1, 0);
          valorHeals.push({ who: p.id, pet: me.name, left: me.valor, petRef: me });
        } else {
          me.valor = VALOR_ROUNDS + 1;   // 本回合末先扣 1，实际覆盖接下来 2 个回合
          valorOn.push({ who: p.id, pet: me.name, rounds: VALOR_ROUNDS, petRef: me });
        }
      }
      // 寒霜雪貂：连续命中，攒满就冻结对手；打已经被冻住的对手不算数
      if (me.trait === 'freeze') {
        const landed = dmgQueue.some((d) => d.attacker === p && d.landed);
        if (landed && !foe.frozen) {
          me.hits = (me.hits || 0) + 1;
          // 记下「是谁攒满的印记」：即使这只雪貂待会儿自己阵亡，冻结也照样成立
          if (me.hits >= FREEZE_NEED) { me.hits = 0; willFreeze.push({ p, pet: me }); }
        } else {
          me.hits = 0;   // 被反弹掉 / 打沙包（对手正被冻着）都不累计
        }
      }
    } else {
      // 打非攻击牌（加血 / 反弹 / 换宠 / 被冻结）会打断雪貂的命中连击
      if (me.trait === 'freeze') me.hits = 0;
      // 战意是「按回合数」算的状态，打别的牌不会解除
    }
  }

  // 3c) 一次性落账：净额之后再夹到 [0, 上限]
  const overflow = new Map(); // 被上限浪费掉的治疗量，用于战报（避免写了 +3 却一点没变）
  for (const [pet, dd] of delta) {
    const raw = pet.hp + dd.heal - dd.dmg;
    overflow.set(pet, Math.max(0, raw - pet.maxHp));
    pet.hp = Math.max(0, Math.min(pet.maxHp, raw));
  }
  const shownHeal = (pet, want) => Math.max(0, want - (overflow.get(pet) || 0));

  // 4) 换命巫祝：交换双方出战宠「结算后的当前血量」，换完再判阵亡。
  //    自己是 0 血、对方 6 血 → 换完自己变 6、对方变 0，于是对方阵亡。
  for (const p of [a, b]) {
    if (eff.get(p.id).type !== 'skill') continue;
    const foe = p === a ? b : a;
    const mine = activePet(p), theirs = activePet(foe);
    const mh = mine.hp, th = theirs.hp;
    mine.hp = Math.max(0, Math.min(mine.maxHp, th));
    theirs.hp = Math.max(0, Math.min(theirs.maxHp, mh));
    ev.push({
      kind: 'skill_hpswap', who: p.id, pet: mine.name, foePet: theirs.name,
      mineHp: mine.hp, foeHp: theirs.hp, fromMine: mh, fromFoe: th,
    });
  }

  // 5a) 战报：加血
  for (const p of [a, b]) {
    const e = eff.get(p.id);
    if (e.type !== 'heal') continue;
    const me = activePet(p);
    const amt = shownHeal(me, e.heal);
    if (amt > 0) ev.push({ kind: 'heal', who: p.id, pet: me.name, amount: amt });
    if (me.trait === 'heal_bench') {
      const bi = benchLowest(p);
      if (bi >= 0) {
        const bench = p.pets[bi];
        const amt2 = shownHeal(bench, 2);
        if (amt2 > 0) ev.push({ kind: 'heal', who: p.id, pet: bench.name, amount: amt2, bench: true });
      }
    }
  }

  // 5b) 战报：伤害与特性
  for (const d of dmgQueue) {
    if (d.reflected) {
      ev.push({ kind: 'reflect', who: d.victim.id, pet: d.victimPet.name, amount: d.dmg });
    } else {
      ev.push({ kind: 'damage', who: d.victim.id, pet: d.victimPet.name, amount: d.dmg });
    }
  }
  for (const d of dmgQueue) {
    if (d.reflected) continue;
    if (d.thorns) {
      // who/pet 指向「实际掉血的宠物」，方便前端做掉血动画
      ev.push({ kind: 'trait_thorns', who: d.attacker.id, pet: d.attackerPet.name, thorn: d.victimPet.name, amount: 1 });
    }
    if (d.lifesteal) {
      const amt = shownHeal(d.attackerPet, 1);
      if (amt > 0) ev.push({ kind: 'trait_lifesteal', who: d.attacker.id, pet: d.attackerPet.name, amount: amt });
    }
    if (d.splashPet) {
      ev.push({ kind: 'trait_splash', who: d.victim.id, pet: d.splashPet.name, amount: 1 });
    }
  }
  for (const t of punishes) {
    ev.push({ kind: 'trait_punish', who: t.who, pet: t.pet, amount: t.amount });
  }
  for (const p of [a, b]) {
    const e = eff.get(p.id);
    if (e.type !== 'attack' || e.card !== 'ATK1') continue;
    const me = activePet(p);
    if (me.trait !== 'atk1_heal') continue;
    const amt = shownHeal(me, 1);
    if (amt > 0) ev.push({ kind: 'trait_atk1heal', who: p.id, pet: me.name, amount: amt });
  }
  for (const t of valorHeals) {
    const amt = shownHeal(t.petRef, 1);
    if (amt > 0) ev.push({ kind: 'trait_valor', who: t.who, pet: t.pet, left: t.left, amount: amt });
  }
  for (const t of valorOn) {
    ev.push({ kind: 'trait_valor_on', who: t.who, pet: t.pet, rounds: t.rounds });
  }

  // 5c) 解冻：冻结只持续「对方的下一个回合」。
  //     这一回合因为被冻而跳过的人，回合结束就自动解冻（不再要求「挨打才醒」）。
  for (const p of [a, b]) {
    if (!p.frozen) continue;
    if (actOf(p).type !== 'freeze') continue;   // 还没轮到他被冻的那个回合
    p.frozen = false;
    ev.push({ kind: 'thaw', who: p.id, pet: activePet(p).name });
  }

  // 6) 死亡与强制换宠
  //    先统一判死，再归因击杀（否则先判死的那一方会算出不一样的结果）
  const deaths = [];
  for (const p of [a, b]) {
    for (const pt of p.pets) {
      if (pt.hp <= 0 && pt.alive) {
        pt.hp = 0;
        pt.alive = false;
        deaths.push({ owner: p, pet: pt });
        ev.push({ kind: 'death', who: p.id, pet: pt.name });
      }
    }
  }

  // 6b) 噬魂骨犬：自己攻击击杀对方出战宠 → 上限 +1、当前血 +3（自己这回合也阵亡就不算）
  for (const d of deaths) {
    const src = dmgQueue.find((q) => !q.reflected && q.victimPet === d.pet);
    const killer = src && src.attackerPet;
    if (!killer || killer.trait !== 'kill_heal' || !killer.alive) continue;
    killer.maxHp += KILL_HEAL_MAX;
    killer.hp = Math.min(killer.maxHp, killer.hp + KILL_HEAL);
    ev.push({
      kind: 'trait_kill_heal', who: src.attacker.id, pet: killer.name,
      victim: d.pet.name, amount: KILL_HEAL, maxUp: KILL_HEAL_MAX,
      hp: killer.hp, maxHp: killer.maxHp,
    });
  }

  for (const p of [a, b]) {
    if (!p.pets[p.activeIdx].alive) {
      const alive = p.pets.map((pt, i) => i).filter((i) => i !== p.activeIdx && p.pets[i].alive);
      if (alive.length) {
        p.activeIdx = alive[0];   // 先自动顶一只，保证状态始终有效
        p.mustPick = true;        // 剩下的（含刚顶上的这只）全部摆出来让玩家自己挑
        ev.push({ kind: 'forced', who: p.id, pet: activePet(p).name });
      }
    }
  }

  // 6c) 战意回合数递减（战意是「按回合」算的状态，打别的牌不会解除）
  for (const p of [a, b]) {
    for (const pt of p.pets) {
      if (pt.trait === 'valor' && pt.valor > 0) pt.valor -= 1;
    }
  }

  // 7) 冻结生效
  //    只要这一击确实命中并攒满了印记，冻结就成立——哪怕寒霜雪貂自己在这一回合被打死。
  //    （之前这里取的是 activePet(p)，雪貂阵亡后已经被自动换成别的宠，导致冻结被吞掉。）
  for (const w of willFreeze) {
    const castPet = w.pet;
    if (!castPet || castPet.trait !== 'freeze') continue;
    const foe = w.p === a ? b : a;
    foe.frozen = true;
    ev.push({ kind: 'freeze', who: foe.id, pet: activePet(foe).name, by: castPet.name, afterDeath: !castPet.alive });
  }
  // 双方同时被冻不再需要特殊处理：两人一起跳过一回合，然后同时自动解冻。

  // 8) 出牌消耗 + 摸牌（换宠 / 被冻结则不摸牌；多打几张就多摸几张）
  for (const p of [a, b]) {
    p.lastDrawn = null;
    p.drawn = [];
    const act = p.pending;
    if (!act) continue;

    let used = 0;
    const take = (key) => {
      const i = p.hand.indexOf(key);
      if (i < 0) return false;
      p.hand.splice(i, 1);
      if (Array.isArray(p.handUids)) p.handUids.splice(i, 1);
      p.discard.push(key); // 打出去的牌进入自己的弃牌堆
      used++;
      return true;
    };

    if (act.type === 'card') {
      const n = Math.max(1, Math.min(HAND_LIMIT, Number(act.count) || 1));
      for (let i = 0; i < n; i++) if (!take(act.card)) break;
    } else if (act.type === 'skill') {
      for (let i = 0; i < SKILL_COST; i++) if (!take('ATK1')) break;
    }
    if (!used) continue;

    for (let i = 0; i < used; i++) {
      const res = draw(room, p);
      if (res.reshuffled) ev.push({ kind: 'reshuffle' });
      if (res.card) {
        p.lastDrawn = res.card;   // 兼容旧逻辑：最后摸到的那张
        p.drawn.push(res.card);
      }
    }
    if (p.drawn.length) ev.push({ kind: 'draw', who: p.id, n: p.drawn.length });
  }

  // 记录本回合双方出的牌 + 换宠前的出战位（供前端揭晓与阵亡动画使用）
  const byPlayer = {};
  for (const p of [a, b]) byPlayer[p.id] = { ...actOf(p) };
  room.reveal = { round: playedRound, byPlayer, beforeActiveIdx, beforeHp };

  room.round++;
  for (const p of [a, b]) p.pending = null;
  room.log = ev;

  // 9) 胜负
  const aDead = a.pets.every((pt) => !pt.alive);
  const bDead = b.pets.every((pt) => !pt.alive);
  if (aDead && bDead) {
    room.phase = 'over';
    room.winner = 'draw';
    room.winReason = '双方宠物同时全灭';
  } else if (aDead) {
    room.phase = 'over';
    room.winner = b.id;
    room.winReason = `${a.label} 的宠物全部阵亡`;
  } else if (bDead) {
    room.phase = 'over';
    room.winner = a.id;
    room.winReason = `${b.label} 的宠物全部阵亡`;
  } else if (noCards(a) && noCards(b)) {
    // 僵局兜底：双方连弃牌堆都空了，比剩余总血量
    const ha = totalHp(a);
    const hb = totalHp(b);
    room.phase = 'over';
    room.winner = ha === hb ? 'draw' : (ha > hb ? a.id : b.id);
    room.winReason = `牌全部打完，按剩余血量判定（${ha} : ${hb}）`;
  }
  return ev;
}

// ---------------------------------------------------------------- 对局内发言
const CHAT_KEEP = 30;    // 服务端保留最近多少条
const CHAT_SEND = 10;    // 每次下发多少条（前端用来显示历史）
const CHAT_MAX_LEN = 60; // 单条最长字数
const CHAT_RATE = 3;     // 每秒最多几条

function handleChat(room, playerId, raw) {
  const p = room.players.get(playerId);
  if (!p) return { ok: false, error: '不在对局中' };

  // 去掉换行、首尾空白；超长直接截断
  let text = String(raw == null ? '' : raw).replace(/[\r\n\t]+/g, ' ').trim();
  if (!text) return { ok: false, error: '发言不能为空' };
  if (text.length > CHAT_MAX_LEN) text = text.slice(0, CHAT_MAX_LEN);

  // 简单限流，防止刷屏
  const now = Date.now();
  if (!Array.isArray(p.chatTimes)) p.chatTimes = [];
  p.chatTimes = p.chatTimes.filter((t) => now - t < 1000);
  if (p.chatTimes.length >= CHAT_RATE) return { ok: false, error: '说得太快了，缓一下' };
  p.chatTimes.push(now);

  if (!Array.isArray(room.chat)) room.chat = [];
  room.chat.push({ who: playerId, label: p.label, text, at: now });
  if (room.chat.length > CHAT_KEEP) room.chat.splice(0, room.chat.length - CHAT_KEEP);
  return { ok: true };
}

// ---------------------------------------------------------------- 视图
function petViews(p) {
  return p.pets.map((pt) => ({
    name: pt.name, hp: pt.hp, maxHp: pt.maxHp,
    alive: pt.alive, desc: pt.desc, trait: pt.trait,
    hits: pt.hits || 0,      // 寒霜雪貂的冻结印记
    valor: pt.valor || 0,    // 战意狂狮：战意状态还剩几个回合
  }));
}

function viewFor(room, playerId) {
  const me = room.players.get(playerId);
  const foe = room.opponentOf(playerId);
  return {
    type: 'state',
    phase: room.phase,
    room: room.id,
    round: room.round,
    deck: me.deck.length,        // 自己牌堆还剩多少（每人一副，互不影响）
    discard: me.discard.length,
    log: room.log,
    reveal: room.reveal,          // 上一回合双方出的牌
    revealing: !!room.revealing,  // 双方都已出牌、等待揭晓
    winner: room.winner,
    winReason: room.winReason,
    freezeNeed: FREEZE_NEED,      // 印记攒到几张就冻结
    handLimit: HAND_LIMIT,
    petsPerPlayer: PETS_PER_PLAYER,   // 每人带几只宠物
    chat: (room.chat || []).slice(-CHAT_SEND),
    you: {
      id: me.id,
      label: me.label,
      // 按「获取顺序」排列（新摸的牌在最右），不再按牌名重排
      hand: me.hand.slice(),
      handUids: (me.handUids || []).slice(),
      pets: petViews(me),
      active: me.activeIdx,
      pending: me.pending,
      frozen: !!me.frozen,
      mustPick: !!me.mustPick,    // 出战宠阵亡、场下还有 2 只：让玩家自己挑一只
      lastDrawn: me.lastDrawn,    // 只给自己，用于摸牌动画
      drawn: (me.drawn || []).slice(),   // 本回合摸到的全部牌（多张牌宠物可能有好几张）
      skill: {
        has: hasSkill(me),
        ready: hasSkill(me) && skillReady(me),
        cost: SKILL_COST,
        card: 'ATK1',
      },
    },
    foe: foe
      ? {
          id: foe.id,
          label: foe.label,
          pets: petViews(foe),
          active: foe.activeIdx,
          handCount: foe.hand.length,
          frozen: !!foe.frozen,
          ready: !!pendingOf(foe),
        }
      : null,
    draft: room.phase === 'draft' && room.draft
      ? {
          pool: room.draft.pool.map((d) => d.id),
          turnId: draftTurnId(room),
          startIdx: room.draft.startIdx,
          youGoFirst: room.order[room.draft.startIdx] === playerId,
          picks: room.draft.picks,
          yourCount: me.pets.length,
        }
      : null,
    choose: room.phase === 'choose' && room.choose
      ? {
          pets: petViews(me),
          picked: room.choose.picked[playerId] != null ? room.choose.picked[playerId] : null,
          foeReady: !!(foe && room.choose.picked[foe.id] != null),
        }
      : null,
  };
}

module.exports = {
  MAX_PLAYERS, HAND_LIMIT, START_HAND, PETS_PER_PLAYER, FREEZE_NEED, SKILL_COST,
  CARDS, CARD_ORDER, DECK_RECIPE, PETS, getPetDef,
  uid, shuffle, makePet, buildDeck,
  activePet, benchIndex, benchList, benchLowest, totalHp, sortHand, hasSkill, skillReady,
  Room, startDraft, handlePick, draftTurnId,
  startChoose, handleChoose,
  startBattle, draw,
  handleAction, handleCancel, handlePickSub, bothReady, pendingOf, resolveRound,
  handleChat, CHAT_SEND, CHAT_MAX_LEN,
  petViews, viewFor,
};
// 测试通用 hook
// 测试通用 hook v2
