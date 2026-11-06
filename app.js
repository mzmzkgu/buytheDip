/* ════════════════════════════════════════════════════════════
   공포매매 (buytheDip) — TQQQ F&G 매매가이드
   - 저장소는 둘 중 하나만 쓴다. 옵션의 Apps Script 웹앱 주소가 비어 있으면 localStorage('buythedip_v1'),
     채워져 있으면 그 구글 시트(listtabs/read/write/deleterow/copytab/settotalseed)에 읽고 쓴다.
   - 시세는 마켓시그널의 signals.json(F&G·VIX·환율)과 무한매수가 쓰는 Cloudflare Worker(TQQQ 가격)에서 읽어 온다.
   ──────────────────────────────────────────────────────────── */
(() => {
'use strict';

// ────────── 상수/설정 ──────────
const STORAGE_KEY = 'buythedip_v1';
// F&G(나스닥 항목)·VIX·달러-원은 마켓시그널이 약 1시간마다 갱신하는 signals.json에서, TQQQ 가격은 무한매수와 같은 Cloudflare Worker에서 가져온다.
const SIGNALS_URL = 'https://mzmzkgu.github.io/marketTraffic/signals.json';
const PRICE_URL = 'https://infinity-api.kgu3405.workers.dev/price?ticker=TQQQ';
const FX_FALLBACK = 1450;
const DEFAULT_SEED = 10000;

const BUY_DEF = [
  { label: 'B1', fg: 25, vix: 20, ratio: 0.10, op: 'AND' },
  { label: 'B2', fg: 20, vix: 25, ratio: 0.15, op: 'AND' },
  { label: 'B3', fg: 15, vix: 30, ratio: 0.20, op: 'AND' },
  { label: 'B4', fg: 10, vix: 35, ratio: 0.25, op: 'AND' },
  { label: 'B5', fg:  5, vix: 40, ratio: 0.30, op: 'OR'  },
];
const SELL_DEF = [
  { label: 'S1', fg: 65, profit: 10, ratio: 0.20 },
  { label: 'S2', fg: 70, profit: 20, ratio: 0.30 },
  { label: 'S3', fg: 75, profit:  0, ratio: 0.50 },
];
const STAGE_IDS = [...BUY_DEF, ...SELL_DEF].map(d => d.label);   // B1~B5, S1~S3

const RATINGS = {
  'extreme fear':  { kr: '극도의 공포', em: '😱', cls: 'extreme-fear' },
  'fear':          { kr: '공포',        em: '😨', cls: 'fear' },
  'neutral':       { kr: '중립',        em: '😐', cls: 'neutral' },
  'greed':         { kr: '탐욕',        em: '😁', cls: 'greed' },
  'extreme greed': { kr: '극도의 탐욕', em: '🤑', cls: 'extreme-greed' },
};

// ────────── 전역 상태 ──────────
const store = {                 // localStorage 에 저장되는 부분
  opts: { theme: 'light', currency: 'USD', scriptUrl: '' },   // scriptUrl 이 있으면 구글 시트 모드
  rounds: [],                   // { id, name, seedUsd, trades: { B1: {date, price, qty, fx, fg, vix}, ... } }
  currentId: null,
  market: null,                 // 마지막으로 받은 시세 (오프라인·API 오류 때 대신 보여줌)
  sheetTab: null,               // 시트 모드에서 마지막으로 본 회차(탭) 이름
};
const sheet = { rounds: [], currentId: null, state: 'idle', error: '' };   // 시트 모드의 작업 사본 (저장하지 않고 매번 시트에서 읽음)
const isSheet = () => !!store.opts.scriptUrl;
const ds = () => (isSheet() ? sheet : store);          // 지금 쓰는 저장소의 { rounds, currentId }
let busy = false;
let market = { fg: null, fg_rating: null, vix: null, vix_state: null, tqqq: null, tqqqChg: null, ndx: null, ndxChg: null, fx: null, ts: null };
let marketStale = false;
const ui = { tab: 'dashboard', editingStage: null, chart: null };

// ────────── 유틸 ──────────
const $ = (id) => document.getElementById(id);
const fmt = (n, d = 0) => (n == null || isNaN(n)) ? '—'
  : Number(n).toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtUsd = (n) => n == null ? '—' : '$' + fmt(n, 2);
const fmtKrw = (n) => n == null ? '—' : fmt(n, 0) + '원';
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

let toastTimer = null;
function toast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2400);
}

// ────────── 저장/불러오기 ──────────
function cleanTrade(t) {
  if (!t || typeof t !== 'object') return null;
  const price = num(t.price), qty = num(t.qty);
  if (!(price > 0) || !(qty > 0)) return null;
  const date = typeof t.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : '';
  return { date, price, qty, fx: num(t.fx), fg: num(t.fg), vix: num(t.vix) };
}
function cleanRound(r) {
  if (!r || typeof r !== 'object') return null;
  const trades = {};
  STAGE_IDS.forEach(id => {
    const t = cleanTrade(r.trades && r.trades[id]);
    if (t) trades[id] = t;
  });
  const seed = num(r.seedUsd);
  return {
    id: typeof r.id === 'string' && r.id ? r.id : uid(),
    name: String(r.name || '이름 없음').slice(0, 40),
    seedUsd: seed > 0 ? seed : DEFAULT_SEED,
    trades,
  };
}
function cleanRounds(list) {
  const out = [], seen = new Set();
  (Array.isArray(list) ? list : []).forEach(r => {
    const c = cleanRound(r);
    if (!c) return;
    while (seen.has(c.id)) c.id = uid();
    seen.add(c.id);
    out.push(c);
  });
  return out;
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.opts) {
      store.opts.theme = d.opts.theme === 'dark' ? 'dark' : 'light';
      store.opts.currency = d.opts.currency === 'KRW' ? 'KRW' : 'USD';
      store.opts.scriptUrl = validScriptUrl(d.opts.scriptUrl) ? d.opts.scriptUrl : '';
    }
    if (typeof d.sheetTab === 'string') store.sheetTab = d.sheetTab;
    store.rounds = cleanRounds(d.rounds);
    store.currentId = store.rounds.some(r => r.id === d.currentId) ? d.currentId : (store.rounds.length ? store.rounds[store.rounds.length - 1].id : null);
    if (d.market && typeof d.market === 'object') {
      market = { ...market, ...d.market };
      marketStale = true;
    }
  } catch (e) { /* 깨진 데이터는 무시하고 빈 상태로 시작 */ }
}
function save() {
  store.market = market;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, ...store }));
  } catch (e) {
    toast('저장 실패: 브라우저 저장공간을 쓸 수 없어요', 'err');
  }
}

const cur = () => ds().rounds.find(r => r.id === ds().currentId) || null;

function validScriptUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && (x.hostname === 'script.google.com' || x.hostname === 'script.googleusercontent.com'); }
  catch (e) { return false; }
}

// ────────── 계산 (예전엔 구글시트가 하던 일) ──────────
const buyCond = (d, m) => d.op === 'AND'
  ? (m.fg != null && m.vix != null && m.fg <= d.fg && m.vix >= d.vix)
  : ((m.fg != null && m.fg <= d.fg) || (m.vix != null && m.vix >= d.vix));
const sellCond = (d, m, c) => c.held > 0 && c.profitPct != null && m.fg != null && m.fg >= d.fg && c.profitPct >= d.profit;

function calc(round) {
  const t = (round && round.trades) || {};
  const buys  = BUY_DEF.map(d => t[d.label] || null);
  const sells = SELL_DEF.map(d => t[d.label] || null);
  const sum = (arr, f) => arr.reduce((a, x) => a + (x ? f(x) : 0), 0);

  const buyQty = sum(buys, x => x.qty), buyAmt = sum(buys, x => x.price * x.qty);
  const sellQty = sum(sells, x => x.qty), sellAmt = sum(sells, x => x.price * x.qty);
  const held = buyQty - sellQty;
  const buyAvg = buyQty > 0 ? buyAmt / buyQty : 0;
  const buyDone = buys.filter(Boolean).length, sellDone = sells.filter(Boolean).length;
  const now = market.tqqq > 0 ? market.tqqq : null;
  const isAllSold = sellDone === SELL_DEF.length;

  let evalUsd, gainUsd, profitPct;
  if (isAllSold) {                       // 사이클 완료: 실제 매도금액 기준
    evalUsd = sellAmt;
    gainUsd = sellAmt - buyAmt;
    profitPct = buyAmt > 0 ? gainUsd / buyAmt * 100 : 0;
  } else if (now != null && buyQty > 0) { // 진행 중: 현재가 기준
    evalUsd = held * now;
    gainUsd = held * (now - buyAvg);
    profitPct = (now - buyAvg) / buyAvg * 100;
  } else {
    evalUsd = gainUsd = profitPct = null;
  }
  return { buys, sells, buyQty, buyAmt, sellQty, sellAmt, held, buyAvg, buyDone, sellDone, isAllSold, evalUsd, gainUsd, profitPct };
}

// ────────── 시장 데이터 (시세 API) ──────────
async function getJson(url, cache) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}
const round2 = (n) => n == null ? null : Math.round(n * 100) / 100;

async function fetchMarket(force = false) {
  const [sig, px] = await Promise.allSettled([
    getJson(SIGNALS_URL, force ? 'reload' : 'default'),
    getJson(PRICE_URL, 'no-store'),
  ]);
  const next = { ...market };
  const times = [];
  const failed = [];

  if (sig.status === 'fulfilled' && sig.value && sig.value.assets) {
    const a = sig.value.assets;
    next.fg = round2(num(a.nasdaq && a.nasdaq.fg_score)) ?? next.fg;
    next.fg_rating = (a.nasdaq && a.nasdaq.fg_rating) || next.fg_rating;
    next.vix = num(a.vix && a.vix.vix) ?? next.vix;
    next.vix_state = (a.vix && a.vix.vix_state) || next.vix_state;
    next.ndx = num(a.nasdaq && a.nasdaq.price) ?? next.ndx;
    next.ndxChg = num(a.nasdaq && a.nasdaq.change_pct) ?? next.ndxChg;
    next.fx = num(a.usdkrw && a.usdkrw.price) ?? next.fx;
    if (sig.value.updated_at) times.push(sig.value.updated_at);
  } else failed.push('F&G·VIX·환율');

  if (px.status === 'fulfilled' && num(px.value && px.value.price) > 0) {
    next.tqqq = num(px.value.price);
    next.tqqqChg = num(px.value.change_pct) ?? next.tqqqChg;
    if (px.value.timestamp) times.push(px.value.timestamp);
  } else failed.push('TQQQ 가격');

  const stamp = times.map(t => new Date(t)).filter(d => !isNaN(d)).sort((x, y) => y - x)[0];
  if (stamp) next.ts = stamp.toISOString();
  market = next;
  marketStale = failed.length > 0;
  if (failed.length < 2) save();
  if (failed.length) toast(`${failed.join('·')}을(를) 못 가져왔어요. ` + (market.ts ? '마지막 저장값을 보여드려요' : '매매 입력 땐 직접 적어도 돼요'), 'err');
  return failed.length === 0;
}

async function handleRefresh() {
  const btn = $('refreshBtn');
  btn.classList.add('refreshing');
  const ok = await fetchMarket(true);
  if (isSheet()) await loadSheet(sheet.currentId);
  renderAll();
  setTimeout(() => btn.classList.remove('refreshing'), 600);
  if (ok) toast('갱신 완료', 'ok');
}

// ────────── 아이콘 (이모지 대신 쓰는 선 아이콘) ──────────
const svg = (body) => `<svg fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">${body}</svg>`;
const ICONS = {
  bell:  svg('<path d="M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 003.4 0"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  flag:  svg('<path d="M5 21V4M5 4h12l-2.5 4L17 12H5"/>'),
  check: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>'),
};

// ────────── 렌더: 시장 현황 ──────────
const GAUGE_ZONES = [[0, 25, '#f04438'], [25, 45, '#f59e0b'], [45, 55, '#adb5bd'], [55, 75, '#7bc47f'], [75, 100, '#17c964']];
function gaugeSvg(score) {
  const pt = (v, r) => { const a = Math.PI * (1 - v / 100); return [60 + r * Math.cos(a), 62 - r * Math.sin(a)]; };
  const arcs = GAUGE_ZONES.map(([from, to, color]) => {
    const [x1, y1] = pt(from, 46), [x2, y2] = pt(to, 46);
    return `<path d="M${x1.toFixed(2)} ${y1.toFixed(2)} A46 46 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}" stroke="${color}" stroke-width="10" fill="none"/>`;
  }).join('');
  let needle = '';
  if (score != null) {
    const [nx, ny] = pt(Math.max(0, Math.min(100, score)), 38);
    needle = `<line x1="60" y1="62" x2="${nx.toFixed(2)}" y2="${ny.toFixed(2)}" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/><circle cx="60" cy="62" r="4.5" fill="currentColor"/>`;
  }
  return `<svg viewBox="0 0 120 68" role="img" aria-label="공포탐욕지수 ${score != null ? score.toFixed(1) : '없음'}">${arcs}${needle}</svg>`;
}
function setDelta(el, pct) {
  el.classList.remove('up', 'down');
  if (pct == null) { el.textContent = '—'; return; }
  el.classList.add(pct >= 0 ? 'up' : 'down');
  el.textContent = (pct >= 0 ? '▲ ' : '▼ ') + Math.abs(pct).toFixed(2) + '%';
}
function renderBoard() {
  const m = market;
  $('fgVal').textContent   = m.fg   != null ? Number(m.fg).toFixed(1)  : '—';
  $('vixVal').textContent  = m.vix  != null ? Number(m.vix).toFixed(2) : '—';
  $('tqqqVal').textContent = m.tqqq != null ? Number(m.tqqq).toFixed(2) : '—';
  $('ndxVal').textContent  = m.ndx  != null ? fmt(m.ndx, 0) : '—';
  $('fxVal').textContent   = m.fx   != null ? fmt(m.fx, 1) : '—';
  setDelta($('ndxChg'), m.ndxChg);
  setDelta($('tqqqChg'), m.tqqqChg);

  const r = RATINGS[(m.fg_rating || '').toLowerCase()] || { kr: '—', cls: 'neutral' };
  $('fgGauge').innerHTML = gaugeSvg(m.fg);
  const rEl = $('fgRating');
  rEl.textContent = r.kr;
  rEl.className = 'fg-rating ' + r.cls;

  const vEl = $('vixState');                       // VIX 구간: 20 미만 안정 / 20~30 불안 / 30 이상 공포
  vEl.textContent = m.vix_state || '';
  vEl.className = 'fg-rating ' + ({ '안정': 'greed', '불안': 'fear', '공포': 'extreme-fear' }[m.vix_state] || 'neutral');
  vEl.style.display = m.vix_state ? '' : 'none';
  const mk = $('vixMarker');
  mk.style.display = m.vix == null ? 'none' : '';
  if (m.vix != null) mk.style.left = Math.max(0, Math.min(100, (m.vix - 10) / 40 * 100)) + '%';   // 10~50 눈금

  let meta = '—';
  if (m.ts) {
    const d = new Date(m.ts);
    if (!isNaN(d)) meta = '갱신: ' + d.toLocaleString('ko-KR', { hour12: false, dateStyle: 'short', timeStyle: 'short' });
  }
  $('boardMeta').textContent = (marketStale && m.ts ? '저장된 값 · ' : '') + meta;
}

// ────────── 렌더: 회차(옵션의 회차선택 + 요약 카드의 회차 이름) ──────────
function renderAcct() {
  const d = ds(), c = cur();
  document.body.dataset.mode = isSheet() ? 'sheet' : 'local';
  $('modeChip').textContent = isSheet() ? '시트' : '로컬';
  $('roundPill').textContent = c ? c.name : (isSheet() && sheet.state === 'loading' ? '불러오는 중…' : '회차 없음');

  let msg = '';
  if (isSheet()) {
    if (sheet.state === 'loading') msg = '구글 시트에서 불러오는 중이에요…';
    else if (sheet.state === 'error') msg = `시트를 불러오지 못했어요 (${esc(sheet.error)}). 오른쪽 위 새로고침으로 다시 시도해 보세요.`;
    else if (!d.rounds.length) msg = '시트에서 회차(탭)를 찾지 못했어요. <button data-act="open-add-round">회차 추가</button>';
  } else if (!d.rounds.length) {
    msg = '아직 회차가 없어요. <button data-act="open-add-round">첫 회차 만들기</button>';
  }
  $('emptyHint').innerHTML = msg;
  $('emptyHint').classList.toggle('hidden', !msg);

  const sel = $('optRound');                         // 옵션의 회차선택 드롭다운
  sel.innerHTML = '';
  if (!d.rounds.length) {
    const o = document.createElement('option'); o.textContent = '회차 없음'; sel.appendChild(o);
  }
  d.rounds.forEach(r => {
    const o = document.createElement('option');
    o.value = r.id; o.textContent = r.name;
    sel.appendChild(o);
  });
  sel.disabled = !d.rounds.length;
  if (c) sel.value = c.id;
}

// ────────── 렌더: 대시보드 ──────────
function renderDashboard() {
  const c = calc(cur());
  const round = cur();
  const useKrw = store.opts.currency === 'KRW';
  const fx = market.fx || FX_FALLBACK;
  const money = (usd) => usd == null ? '—' : (useKrw ? fmtKrw(usd * fx) : fmtUsd(usd));
  const hasBuy = c.buyQty > 0;

  const inv = $('sumInvest');                        // 투자 전에는 금액 대신 '투자 전'
  inv.textContent = hasBuy ? money(c.buyAmt) : '투자 전';
  inv.classList.toggle('muted', !hasBuy);
  $('sumAvg').textContent = hasBuy ? fmtUsd(c.buyAvg) : '—';
  $('sumQty').textContent = hasBuy ? fmt(c.isAllSold ? c.buyQty : c.held, 0) + '주' : '—';
  $('sumEval').textContent = hasBuy ? money(c.evalUsd) : '—';

  const g = $('sumGain');                            // 평가손익: [+$272.05 (+12.1%)] / [-$244.72 (-9.7%)]
  if (hasBuy && c.gainUsd != null) {
    const up = c.gainUsd >= 0;
    g.textContent = (up ? '+' : '-') + money(Math.abs(c.gainUsd)) + ' (' + (up ? '+' : '-') + Math.abs(c.profitPct).toFixed(1) + '%)';
    g.className = 'delta ' + (up ? 'up' : 'down');
  } else {
    g.textContent = '—';
    g.className = 'dash';
  }

  renderStagePills('buyStages', BUY_DEF, c, false);
  renderStagePills('sellStages', SELL_DEF, c, true);
  renderStatus(round ? statusInfo(c) : { kind: 'info', icon: 'clock', text: '회차를 추가하면 현재 상태를 알려드려요' });
  renderChart(c);
}

function renderStagePills(containerId, defs, c, isSell) {
  const box = $(containerId);
  box.innerHTML = '';
  const used = isSell ? c.sells : c.buys;
  defs.forEach((d, i) => {
    const done = !!used[i];
    // 입력이 끝난 칸도 조건을 계속 확인한다: 입력됨 = 색 채움, 조건 충족 = 깜빡이는 테두리 (둘 다면 같이)
    const can = isSell ? sellCond(d, market, c) : buyCond(d, market);
    const pill = document.createElement('div');
    pill.className = 'stage-pill' + (done ? (isSell ? ' done-sell' : ' done') : '') + (can ? ' can' : '');
    pill.textContent = d.label;
    box.appendChild(pill);
  });
}

function statusInfo(c) {
  for (let i = 0; i < BUY_DEF.length; i++) {
    if (c.buys[i]) continue;
    const d = BUY_DEF[i];
    if (buyCond(d, market)) return { kind: 'alert', icon: 'bell', text: `${d.label} 매수 조건 충족 · 시드의 ${(d.ratio * 100).toFixed(0)}% 매수 타이밍` };
  }
  for (let i = 0; i < SELL_DEF.length; i++) {
    if (c.sells[i]) continue;
    const d = SELL_DEF[i];
    if (sellCond(d, market, c)) return { kind: 'sell', icon: 'bell', text: `${d.label} 매도 조건 충족 · 평가액의 ${(d.ratio * 100).toFixed(0)}% 매도 타이밍` };
  }
  if (c.buyDone === 0) return { kind: 'info', icon: 'clock', text: '아직 매수 시작 전 · F&G 조건 대기' };
  if (c.sellDone === SELL_DEF.length) return { kind: 'info', icon: 'check', text: '모든 매도 단계 완료' };
  return { kind: 'info', icon: 'flag', text: `현재 단계: ${c.buyDone === BUY_DEF.length ? 'B5' : 'B' + c.buyDone} 매수 완료${c.sellDone > 0 ? ` / S${c.sellDone} 매도 진행` : ''}` };
}
function renderStatus(st) {                           // 말풍선 모양 상태 안내
  const el = $('statusLine');
  el.className = 'status-line' + (st.kind === 'alert' ? ' alert' : st.kind === 'sell' ? ' sell' : '');
  el.innerHTML = ICONS[st.icon] + '<span>' + esc(st.text) + '</span>';
}

// ────────── 렌더: 차트 ──────────
function renderChart(c) {
  if (ui.chart) { ui.chart.destroy(); ui.chart = null; }
  const msg = $('chartMsg');                      // 못 그리는 이유를 빈 칸 대신 알려준다
  const hasTrades = !!(cur() && Object.keys(cur().trades).length);
  msg.textContent = typeof Chart === 'undefined' ? '차트를 불러오지 못했어요. 새로고침해 보세요.' : (hasTrades ? '' : '매매 기록을 입력하면 자금 흐름이 그려져요.');
  msg.classList.toggle('hidden', !msg.textContent);
  if (typeof Chart === 'undefined') return;
  const round = cur();
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const useKrw = store.opts.currency === 'KRW';
  const fx = market.fx || FX_FALLBACK;

  // 기록된 매매를 날짜순(같은 날이면 단계순)으로 누적
  const list = STAGE_IDS
    .map((id, i) => ({ id, i, t: round && round.trades[id] }))
    .filter(x => x.t)
    .sort((a, b) => (a.t.date || '').localeCompare(b.t.date || '') || a.i - b.i);

  const labels = [], invested = [], valuation = [];
  let cumQty = 0, cumCost = 0;
  list.forEach(({ id, t }) => {
    if (id[0] === 'B') { cumQty += t.qty; cumCost += t.price * t.qty; }
    else {
      const avg = cumQty > 0 ? cumCost / cumQty : 0;
      cumCost -= avg * t.qty;
      cumQty -= t.qty;
    }
    labels.push([id, (t.date || '').slice(2)]);
    invested.push(cumCost);
    valuation.push(cumQty * t.price);            // 그 시점 가격 기준
  });
  if (list.length) {
    labels.push('현재');
    invested.push(cumCost);
    valuation.push(market.tqqq > 0 ? cumQty * market.tqqq : null);
  }

  const toDisp = (v) => v == null ? null : (useKrw ? v * fx : v);
  const unit = useKrw ? '₩' : '$';
  const textColor = css('--text-sub'), gridColor = css('--border');

  ui.chart = new Chart($('dashChart').getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: '평가금액', data: valuation.map(toDisp), borderColor: '#f04438', backgroundColor: 'rgba(240,68,56,.15)', fill: true, tension: 0.3, borderWidth: 2, pointRadius: 3, pointHoverRadius: 5 },
        { label: '투자금액', data: invested.map(toDisp), borderColor: css('--text'), backgroundColor: 'rgba(128,128,128,.12)', fill: true, tension: 0.3, borderWidth: 2, pointRadius: 3, pointHoverRadius: 5 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { color: textColor, font: { size: 11, weight: '600' }, boxWidth: 10 } },
        tooltip: { callbacks: { label: (x) => `${x.dataset.label}: ${unit}${fmt(x.parsed.y, useKrw ? 0 : 2)}` } },
      },
      scales: {
        x: { ticks: { color: textColor, font: { size: 10 } }, grid: { color: gridColor } },
        y: { ticks: { color: textColor, callback: (v) => unit + fmt(v, 0), font: { size: 10 } }, grid: { color: gridColor } },
      },
    },
  });
}

// ────────── 렌더: 매매기록 탭 ──────────
function rowHtml(def, t, hint, ratioStr) {
  return `
    <div><div class="stage-badge">${def.label}</div></div>
    <div>${t && t.date ? esc(t.date.slice(2)) : '—'}</div>
    <div>${t ? `$${fmt(t.price, 2)} × ${fmt(t.qty, 0)}주` : hint}</div>
    <div>${ratioStr}</div>
    <div><button class="action-btn ${t ? '' : 'primary'}" data-act="open-trade" data-stage="${def.label}">${t ? '수정' : '입력'}</button></div>`;
}

function renderRecords() {
  const round = cur();
  const c = calc(round);
  const seed = round ? round.seedUsd : DEFAULT_SEED;

  const buyBox = $('buyRows');
  buyBox.innerHTML = '';
  BUY_DEF.forEach((d, i) => {
    const t = c.buys[i];
    const ready = !t && buyCond(d, market);
    const el = document.createElement('div');
    el.className = 'trade-row' + (t ? ' done' : ready ? ' ready' : '');
    const hint = `F&G ≤${d.fg} ${d.op === 'OR' ? '또는' : '&amp;'} VIX ≥${d.vix}`;
    el.innerHTML = rowHtml(d, t, hint, `${(d.ratio * 100).toFixed(0)}% ($${fmt(seed * d.ratio, 0)})`);
    buyBox.appendChild(el);
  });
  $('buyCount').textContent = `${c.buyDone}/${BUY_DEF.length}`;

  // S1 을 판 뒤에는 그때 평가액(= S1 매도액 ÷ 20%)을 기준으로 S2·S3 금액을 고정해서 보여준다
  const s1 = c.sells[0];
  const baseUsd = s1 ? (s1.price * s1.qty) / SELL_DEF[0].ratio : (c.held > 0 && market.tqqq > 0 ? c.held * market.tqqq : 0);

  const sellBox = $('sellRows');
  sellBox.innerHTML = '';
  SELL_DEF.forEach((d, i) => {
    const t = c.sells[i];
    const ready = !t && sellCond(d, market, c);
    const amt = baseUsd * d.ratio;
    const el = document.createElement('div');
    el.innerHTML = rowHtml(d, t, `F&G ≥${d.fg} &amp; 수익 ≥${d.profit}%`, `${(d.ratio * 100).toFixed(0)}% ${amt > 0 ? '($' + fmt(amt, 0) + ')' : ''}`);
    el.className = 'trade-row' + (t ? ' done sell' : ready ? ' ready' : '');
    sellBox.appendChild(el);
  });
  $('sellCount').textContent = `${c.sellDone}/${SELL_DEF.length}`;
}

function renderAll() {
  renderBoard();
  renderAcct();
  renderDashboard();
  renderRecords();
}

// ────────── 탭/모달 ──────────
function switchTab(t) {
  ui.tab = t;
  document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.tab === t));
  $('tabDashboard').classList.toggle('hidden', t !== 'dashboard');
  $('tabRecords').classList.toggle('hidden', t !== 'records');
  if (t === 'dashboard') renderDashboard();      // 숨겨진 상태에서 그린 차트 크기가 틀어지는 것 방지
}
const openModal  = (id) => $(id).classList.add('open');
function closeModal(id) {
  $(id).classList.remove('open');
  if (id === 'tradeModalBg') ui.editingStage = null;
}

// ────────── 매매 입력 ──────────
function openTradeModal(stage) {
  const round = cur();
  if (!round) {
    toast('먼저 회차를 추가해 주세요', 'err');
    openAddRound();
    return;
  }
  ui.editingStage = stage;
  $('tradeModalTitle').textContent = `${round.name} · ${stage} ${stage[0] === 'B' ? '매수' : '매도'} 기록`;
  const t = round.trades[stage];
  const v = (x) => x == null ? '' : x;
  if (t) {
    $('tDate').value = t.date; $('tPrice').value = t.price; $('tQty').value = t.qty;
    $('tFx').value = v(t.fx); $('tFg').value = v(t.fg); $('tVix').value = v(t.vix);
    $('tradeDeleteBtn').style.display = '';
  } else {
    $('tDate').value = todayStr(); $('tPrice').value = v(market.tqqq); $('tQty').value = '';
    $('tFx').value = v(market.fx); $('tFg').value = v(market.fg); $('tVix').value = v(market.vix);
    $('tradeDeleteBtn').style.display = 'none';
  }
  openModal('tradeModalBg');
}

async function submitTrade() {
  const round = cur(), stage = ui.editingStage;
  if (!round || !stage) return;
  const t = { date: $('tDate').value, price: num($('tPrice').value), qty: num($('tQty').value),
              fx: num($('tFx').value), fg: num($('tFg').value), vix: num($('tVix').value) };
  if (!t.date || !(t.price > 0) || !(t.qty > 0)) { toast('매매일·가격·수량은 필수예요', 'err'); return; }

  if (stage[0] === 'S') {                        // 보유 수량보다 많이 파는 입력은 한 번 더 확인
    const prev = round.trades[stage];
    const heldBefore = calc(round).held + (prev ? prev.qty : 0);
    if (t.qty > heldBefore && !confirm(`보유 수량(${fmt(heldBefore, 0)}주)보다 많이 팔았다고 기록돼요. 그래도 저장할까요?`)) return;
  }
  if (isSheet()) {
    const ok = await sheetTask('시트에 저장하는 중…', async () => {
      await sheetCall('write', { tab: round.id }, { stage, date: t.date, trade_price: t.price, qty: t.qty, fx: t.fx, fg: t.fg, vix: t.vix });
      await refreshSheetRound(round.id);
    });
    if (!ok) return;
  } else {
    round.trades[stage] = t;
    save();
  }
  closeModal('tradeModalBg');
  renderAll();
  toast('저장 완료', 'ok');
}

async function deleteTrade() {
  const round = cur(), stage = ui.editingStage;
  if (!round || !stage || !round.trades[stage]) return;
  if (!confirm(`${stage} 기록을 삭제할까요?`)) return;
  if (isSheet()) {
    const ok = await sheetTask('시트에서 삭제하는 중…', async () => {
      await sheetCall('deleterow', { tab: round.id }, { stage });
      await refreshSheetRound(round.id);
    });
    if (!ok) return;
  } else {
    delete round.trades[stage];
    save();
  }
  closeModal('tradeModalBg');
  renderAll();
  toast('삭제 완료', 'ok');
}

// ────────── 회차 관리 ──────────
function openAddRound() {
  closeModal('optBg');                           // 옵션에서 눌러도 추가 창이 위에 보이도록
  $('newRoundName').value = '';
  const c = cur();
  $('newRoundSeed').value = c ? c.seedUsd : DEFAULT_SEED;
  if (isSheet()) {                               // 시트 모드: 복제할 탭을 고른다
    const sel = $('newRoundSrc');
    sel.innerHTML = '';
    sheet.rounds.forEach(r => { const o = document.createElement('option'); o.value = r.id; o.textContent = r.name; sel.appendChild(o); });
    if (c) sel.value = c.id;
  }
  openModal('addRoundBg');
}
async function submitAddRound() {
  const name = $('newRoundName').value.trim().slice(0, 40);
  const seed = num($('newRoundSeed').value);
  if (!name) { toast('회차 이름을 적어 주세요', 'err'); return; }
  if (!(seed > 0)) { toast('시드는 0보다 커야 해요', 'err'); return; }
  if (isSheet()) {
    const src = $('newRoundSrc').value;
    if (!src) { toast('복제할 탭이 없어요. 시트에 기준이 될 탭을 먼저 만들어 주세요', 'err'); return; }
    if (sheet.rounds.some(r => r.id === name)) { toast('같은 이름의 탭이 이미 있어요', 'err'); return; }
    const ok = await sheetTask('시트에 새 탭을 만드는 중…', async () => {
      await sheetCall('copytab', {}, { source: src, target: name });
      try { await sheetCall('settotalseed', { tab: name }, { value: seed }); } catch (e) { /* 시드 저장 실패는 무시 */ }
    });
    if (!ok) return;
    closeModal('addRoundBg');
    await loadSheet(name);
    toast('회차 추가됨', 'ok');
    return;
  }
  const r = { id: uid(), name, seedUsd: seed, trades: {} };
  store.rounds.push(r);
  store.currentId = r.id;
  save();
  closeModal('addRoundBg');
  renderAll();
  toast('회차 추가됨', 'ok');
}
function renameRound() {
  const c = cur();
  if (!c || isSheet()) return;
  const name = (prompt('회차 이름', c.name) || '').trim();
  if (!name) return;
  c.name = name.slice(0, 40);
  save();
  renderAll();
}
function deleteRound() {
  const c = cur();
  if (!c || isSheet()) return;
  if (!confirm(`'${c.name}' 회차와 모든 매매기록을 삭제할까요?\n(되돌릴 수 없어요 — 먼저 백업 내보내기를 권해요)`)) return;
  store.rounds = store.rounds.filter(r => r.id !== c.id);
  store.currentId = store.rounds.length ? store.rounds[store.rounds.length - 1].id : null;
  save();
  closeModal('optBg');
  renderAll();
  toast('삭제 완료', 'ok');
}

// ────────── 옵션 ──────────
function openOptions() {
  const c = cur();
  $('optDark').checked = store.opts.theme === 'dark';
  $('optSeed').value = c ? c.seedUsd : '';
  $('optSeed').disabled = !c;
  $('optScriptUrl').value = store.opts.scriptUrl || '';
  document.querySelectorAll('#segCurrency button').forEach(b => b.classList.toggle('active', b.dataset.v === store.opts.currency));
  openModal('optBg');
}
async function saveOptions() {
  const url = $('optScriptUrl').value.trim();
  if (url && !validScriptUrl(url)) { toast('Apps Script 웹앱 주소(https://script.google.com/...)를 넣어 주세요', 'err'); return; }

  if (url !== store.opts.scriptUrl) {            // 저장 위치 바꾸기: 로컬 ↔ 시트 (한쪽만 쓴다)
    store.opts.scriptUrl = url;
    sheet.rounds = []; sheet.currentId = null; sheet.state = 'idle'; sheet.error = '';
    save();
    closeModal('optBg');
    toast(url ? '구글 시트에 저장하는 방식으로 바꿨어요' : '이 브라우저(로컬)에 저장하는 방식으로 바꿨어요', 'ok');
    if (url) await loadSheet(store.sheetTab); else renderAll();
    return;
  }
  const c = cur();
  const seed = num($('optSeed').value);
  if (c && seed > 0 && seed !== c.seedUsd) {
    if (isSheet()) {
      const ok = await sheetTask('시트에 시드를 저장하는 중…', async () => {
        await sheetCall('settotalseed', { tab: c.id }, { value: seed });
        await refreshSheetRound(c.id);
      });
      if (!ok) return;
    } else {
      c.seedUsd = seed;
      save();
    }
  }
  closeModal('optBg');
  renderAll();
  toast('저장됨', 'ok');
}
function setTheme(dark) {
  store.opts.theme = dark ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', store.opts.theme === 'dark' ? 'dark' : '');
  save();
  renderDashboard();
}
function setCurrency(c) {
  store.opts.currency = c;
  document.querySelectorAll('#segCurrency button').forEach(b => b.classList.toggle('active', b.dataset.v === c));
  save();
  renderDashboard();
}

// ────────── 백업 (JSON) ──────────
function exportJson() {
  const data = { app: 'buythedip', v: 1, exportedAt: new Date().toISOString(), opts: { theme: store.opts.theme, currency: store.opts.currency }, rounds: store.rounds };   // 시트 웹앱 주소는 백업에 넣지 않는다
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'buythedip-' + todayStr().replace(/-/g, '') + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function importJson(file) {
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (d.app !== 'buythedip') throw new Error('공포매매 백업 파일이 아니에요');
    const rounds = cleanRounds(d.rounds);
    if (!rounds.length) throw new Error('가져올 회차가 없어요');
    if (store.rounds.length && !confirm(`지금 저장된 회차 ${store.rounds.length}개를 지우고 백업의 ${rounds.length}개로 바꿀까요?`)) return;
    store.rounds = rounds;
    store.currentId = rounds[rounds.length - 1].id;
    save();
    closeModal('optBg');
    renderAll();
    toast(`회차 ${rounds.length}개를 가져왔어요`, 'ok');
  } catch (e) {
    toast('가져오기 실패: ' + e.message, 'err');
  } finally {
    $('importFile').value = '';
  }
}

// ────────── 구글 시트 모드 (Apps Script 웹앱) ──────────
function normDate(v) {
  if (typeof v !== 'string' || !v) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  if (isNaN(d)) return '';
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);   // 한국 날짜로 변환
}
async function sheetCall(action, params = {}, body = null) {
  const base = store.opts.scriptUrl;
  const qs = new URLSearchParams({ action, ...params }).toString();
  const url = base + (base.includes('?') ? '&' : '?') + qs;
  // body 는 문자열 그대로 보낸다 (Content-Type 을 안 붙여야 CORS 사전 요청 없이 Apps Script 가 받는다)
  const init = body ? { method: 'POST', body: JSON.stringify(body), redirect: 'follow' } : { method: 'GET', redirect: 'follow' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 40000);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (d && d.error) throw new Error(d.error);
    return d;
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? '시트 응답이 너무 늦어요' : e.message);
  } finally {
    clearTimeout(timer);
  }
}
async function readSheetRound(name) {
  const res = await sheetCall('read', { tab: name });
  if (!res || !Array.isArray(res.rows)) throw new Error('회차 탭이 아니에요');
  const trades = {};
  res.rows.slice(0, STAGE_IDS.length).forEach((row, i) => {
    if (!row || !row.stage_used) return;
    const t = cleanTrade({ date: normDate(row.date), price: row.trade_price, qty: row.qty, fx: row.fx, fg: row.fg, vix: row.vix });
    if (t) trades[STAGE_IDS[i]] = t;
  });
  const seed = num(res.summary && res.summary.total_seed_usd);
  return { id: name, name, seedUsd: seed > 0 ? seed : DEFAULT_SEED, trades };
}
async function refreshSheetRound(name) {
  const r = await readSheetRound(name);
  const i = sheet.rounds.findIndex(x => x.id === name);
  if (i >= 0) sheet.rounds[i] = r; else sheet.rounds.push(r);
}
async function loadSheet(prefer) {
  sheet.state = 'loading'; sheet.error = '';
  renderAll();
  try {
    const { tabs } = await sheetCall('listtabs');
    if (!Array.isArray(tabs)) throw new Error('탭 목록을 받지 못했어요');
    const results = await Promise.allSettled(tabs.map(readSheetRound));       // 회차가 아닌 탭은 읽기에 실패하므로 자동으로 빠진다
    sheet.rounds = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const names = sheet.rounds.map(r => r.id);
    sheet.currentId = [prefer, store.sheetTab].find(n => names.includes(n)) || names[names.length - 1] || null;
    if (sheet.currentId && sheet.currentId !== store.sheetTab) { store.sheetTab = sheet.currentId; save(); }   // 다음에 열 때 이 탭으로
    sheet.state = 'ready';
  } catch (e) {
    sheet.rounds = []; sheet.currentId = null;
    sheet.state = 'error'; sheet.error = e.message;
  }
  renderAll();
}
async function sheetTask(label, fn) {            // 시트에 쓰는 동안 중복 클릭을 막고 오류를 알려준다
  if (busy) return false;
  busy = true;
  document.body.classList.add('busy');
  toast(label);
  try { await fn(); return true; }
  catch (e) { toast('시트 오류: ' + e.message, 'err'); return false; }
  finally { busy = false; document.body.classList.remove('busy'); }
}
function copySheetToLocal() {                    // 시트 모드에서 읽어 둔 회차를 이 브라우저에도 복사 (시트는 안 바뀜)
  const src = sheet.rounds.filter(r => Object.keys(r.trades).length);
  if (!src.length) { toast('복사할 매매 기록이 없어요', 'err'); return; }
  if (!confirm(`시트의 회차 ${src.length}개를 이 브라우저(로컬)에 복사할까요?\n(시트는 바뀌지 않고, 같은 이름이 있으면 '(시트)'를 붙여요)`)) return;
  src.forEach(r => {
    let name = r.name;
    if (store.rounds.some(x => x.name === name)) name = name.slice(0, 33) + ' (시트)';
    store.rounds.push({ id: uid(), name, seedUsd: r.seedUsd, trades: JSON.parse(JSON.stringify(r.trades)) });
  });
  save();
  toast(`회차 ${src.length}개를 이 브라우저에 복사했어요`, 'ok');
}

// ────────── 이벤트 ──────────
const ACTIONS = {
  'refresh':         () => handleRefresh(),
  'open-options':    () => openOptions(),
  'save-options':    () => saveOptions(),
  'tab':             (el) => switchTab(el.dataset.tab),
  'open-add-round':  () => openAddRound(),
  'submit-add-round': () => submitAddRound(),
  'toggle-section':  (el) => { el.classList.toggle('open'); $(el.dataset.body).classList.toggle('open'); },
  'open-trade':      (el) => openTradeModal(el.dataset.stage),
  'save-trade':      () => submitTrade(),
  'delete-trade':    () => deleteTrade(),
  'close-modal':     (el) => closeModal(el.dataset.close),
  'set-currency':    (el) => setCurrency(el.dataset.v),
  'rename-round':    () => renameRound(),
  'delete-round':    () => deleteRound(),
  'export-json':     () => exportJson(),
  'import-json':     () => $('importFile').click(),
  'copy-sheet-local': () => copySheetToLocal(),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el) {
    if (el.dataset.act === 'bg-close') { if (e.target === el) closeModal(el.dataset.close); }
    else if (ACTIONS[el.dataset.act]) ACTIONS[el.dataset.act](el);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-bg.open').forEach(m => closeModal(m.id));
  } else if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.tab, .trade-header')) {
    e.preventDefault();
    e.target.click();
  }
});
$('optDark').addEventListener('change', (e) => setTheme(e.target.checked));
$('optRound').addEventListener('change', (e) => {            // 옵션의 회차선택: 고르면 바로 그 회차로 바뀜
  if (!e.target.value) return;
  ds().currentId = e.target.value;
  if (isSheet()) store.sheetTab = e.target.value;
  save();
  renderAll();
  const c = cur();                                             // 총 시드 칸도 고른 회차의 값으로 (저장 시 이전 회차 값이 덮어쓰지 않도록)
  $('optSeed').value = c ? c.seedUsd : '';
  $('optSeed').disabled = !c;
});
$('importFile').addEventListener('change', (e) => importJson(e.target.files[0]));

// ────────── 시작 ──────────
document.querySelectorAll('.tab, .trade-header').forEach(el => { el.tabIndex = 0; el.setAttribute('role', 'button'); });
load();
document.documentElement.setAttribute('data-theme', store.opts.theme === 'dark' ? 'dark' : '');
document.querySelectorAll('#segCurrency button').forEach(b => b.classList.toggle('active', b.dataset.v === store.opts.currency));
renderAll();
fetchMarket().then(renderAll);
if (isSheet()) loadSheet(store.sheetTab);

})();
