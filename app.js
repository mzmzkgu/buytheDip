/* ════════════════════════════════════════════════════════════
   줍줍매매 (buytheDip) — TQQQ F&G 매매가이드
   - 기록은 localStorage('buythedip_v1')에만 저장한다. (서버·구글시트 연동 없음)
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
  opts: { theme: 'light', currency: 'USD' },
  rounds: [],                   // { id, name, seedUsd, trades: { B1: {date, price, qty, fx, fg, vix}, ... } }
  currentId: null,
  market: null,                 // 마지막으로 받은 시세 (오프라인·API 오류 때 대신 보여줌)
};
let market = { fg: null, fg_rating: null, vix: null, tqqq: null, fx: null, ts: null };
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
    }
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

const cur = () => store.rounds.find(r => r.id === store.currentId) || null;

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
    next.fx = num(a.usdkrw && a.usdkrw.price) ?? next.fx;
    if (sig.value.updated_at) times.push(sig.value.updated_at);
  } else failed.push('F&G·VIX·환율');

  if (px.status === 'fulfilled' && num(px.value && px.value.price) > 0) {
    next.tqqq = num(px.value.price);
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
  renderAll();
  setTimeout(() => btn.classList.remove('refreshing'), 600);
  if (ok) toast('갱신 완료', 'ok');
}

// ────────── 렌더: 전광판 ──────────
function renderBoard() {
  const m = market;
  $('fgVal').textContent   = m.fg   != null ? Number(m.fg).toFixed(1)  : '—';
  $('vixVal').textContent  = m.vix  != null ? Number(m.vix).toFixed(2) : '—';
  $('tqqqVal').textContent = m.tqqq != null ? Number(m.tqqq).toFixed(2) : '—';
  $('fxVal').textContent   = m.fx   != null ? fmt(m.fx, 1) : '—';

  const r = RATINGS[(m.fg_rating || '').toLowerCase()] || { kr: '—', em: '', cls: 'neutral' };
  $('fgEmoji').textContent = r.em;
  const rEl = $('fgRating');
  rEl.textContent = r.kr;
  rEl.className = 'fg-rating ' + r.cls;

  let meta = '—';
  if (m.ts) {
    const d = new Date(m.ts);
    if (!isNaN(d)) meta = '갱신: ' + d.toLocaleString('ko-KR', { hour12: false, dateStyle: 'short', timeStyle: 'short' });
  }
  $('boardMeta').textContent = (marketStale && m.ts ? '저장된 값 · ' : '') + meta;
}

// ────────── 렌더: 회차 선택 ──────────
function renderAcct() {
  const c = cur();
  $('acctLabel').textContent = c ? c.name : '회차 없음';
  $('emptyHint').classList.toggle('hidden', store.rounds.length > 0);
  const dd = $('acctDropdown');
  dd.innerHTML = '';
  store.rounds.forEach(r => {
    const el = document.createElement('div');
    el.className = 'select-option' + (r.id === store.currentId ? ' selected' : '');
    el.textContent = r.name;
    el.dataset.act = 'pick-round';
    el.dataset.id = r.id;
    dd.appendChild(el);
  });
}

// ────────── 렌더: 대시보드 ──────────
function renderDashboard() {
  const c = calc(cur());
  const round = cur();
  const useKrw = store.opts.currency === 'KRW';
  const fx = market.fx || FX_FALLBACK;
  const money = (usd) => usd == null ? '—' : (useKrw ? fmtKrw(usd * fx) : fmtUsd(usd));
  const signed = (usd) => usd == null ? '—' : (usd >= 0 ? '+' : '') + money(usd);
  const hasBuy = c.buyQty > 0;

  $('sumInvest').textContent = hasBuy ? money(c.buyAmt) : '—';
  $('sumEval').textContent   = hasBuy ? money(c.evalUsd) : '—';
  $('sumAvg').textContent    = hasBuy ? fmtUsd(c.buyAvg) : '—';
  // 투자시드: 진행 중이면 회차에 정한 시드, 사이클이 끝났으면 실제 투자금
  $('sumSeed').textContent   = c.isAllSold ? money(c.buyAmt) : (round ? money(round.seedUsd) : '—');

  const gainEl = $('sumGain'), pctEl = $('sumProfitPct');
  if (hasBuy && c.gainUsd != null) {
    gainEl.textContent = signed(c.gainUsd);
    gainEl.className = 'v ' + (c.gainUsd >= 0 ? 'positive' : 'negative');
    pctEl.textContent = (c.profitPct >= 0 ? '+' : '') + c.profitPct.toFixed(2) + '%';
    pctEl.className = 'v ' + (c.profitPct >= 0 ? 'positive' : 'negative');
  } else {
    gainEl.textContent = pctEl.textContent = '—';
    gainEl.className = pctEl.className = 'v';
  }

  renderStagePills('buyStages', BUY_DEF, c, false);
  renderStagePills('sellStages', SELL_DEF, c, true);
  $('statusLine').textContent = round ? buildStatusMessage(c) : '회차를 추가하면 현재 상태를 알려드려요';
  renderChart(c);
}

function renderStagePills(containerId, defs, c, isSell) {
  const box = $(containerId);
  box.innerHTML = '';
  const used = isSell ? c.sells : c.buys;
  defs.forEach((d, i) => {
    const done = !!used[i];
    const can = !done && (isSell ? sellCond(d, market, c) : buyCond(d, market));
    const pill = document.createElement('div');
    pill.className = 'stage-pill' + (done ? (isSell ? ' done-sell' : ' done') : '') + (can ? ' can' : '');
    pill.textContent = d.label;
    box.appendChild(pill);
  });
}

function buildStatusMessage(c) {
  for (let i = 0; i < BUY_DEF.length; i++) {
    if (c.buys[i]) continue;
    const d = BUY_DEF[i];
    if (buyCond(d, market)) return `🚨 ${d.label} 매수 조건 충족! (시드의 ${(d.ratio * 100).toFixed(0)}% 매수 타이밍)`;
  }
  for (let i = 0; i < SELL_DEF.length; i++) {
    if (c.sells[i]) continue;
    const d = SELL_DEF[i];
    if (sellCond(d, market, c)) return `💰 ${d.label} 매도 조건 충족! (평가액의 ${(d.ratio * 100).toFixed(0)}% 매도 타이밍)`;
  }
  if (c.buyDone === 0) return '⏸ 아직 매수 시작 전 (F&G 조건 대기)';
  if (c.sellDone === SELL_DEF.length) return '✅ 모든 매도 단계 완료';
  return `📍 현재 단계: ${c.buyDone === BUY_DEF.length ? 'B5' : 'B' + c.buyDone} 매수 완료${c.sellDone > 0 ? ` / S${c.sellDone} 매도 진행` : ''}`;
}

// ────────── 렌더: 차트 ──────────
function renderChart(c) {
  if (ui.chart) { ui.chart.destroy(); ui.chart = null; }
  if (typeof Chart === 'undefined') return;       // CDN 을 못 불러온 경우
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
        { label: '평가금', data: valuation.map(toDisp), borderColor: '#f04438', backgroundColor: 'rgba(240,68,56,.15)', fill: true, tension: 0.3, borderWidth: 2, pointRadius: 3, pointHoverRadius: 5 },
        { label: '투자시드', data: invested.map(toDisp), borderColor: css('--text'), backgroundColor: 'rgba(128,128,128,.12)', fill: true, tension: 0.3, borderWidth: 2, pointRadius: 3, pointHoverRadius: 5 },
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

function submitTrade() {
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
  round.trades[stage] = t;
  save();
  closeModal('tradeModalBg');
  renderAll();
  toast('저장 완료 ✅', 'ok');
}

function deleteTrade() {
  const round = cur(), stage = ui.editingStage;
  if (!round || !stage || !round.trades[stage]) return;
  if (!confirm(`${stage} 기록을 삭제할까요?`)) return;
  delete round.trades[stage];
  save();
  closeModal('tradeModalBg');
  renderAll();
  toast('삭제 완료', 'ok');
}

// ────────── 회차 관리 ──────────
function openAddRound() {
  $('newRoundName').value = '';
  const c = cur();
  $('newRoundSeed').value = c ? c.seedUsd : DEFAULT_SEED;
  openModal('addRoundBg');
}
function submitAddRound() {
  const name = $('newRoundName').value.trim();
  const seed = num($('newRoundSeed').value);
  if (!name) { toast('회차 이름을 적어 주세요', 'err'); return; }
  if (!(seed > 0)) { toast('시드는 0보다 커야 해요', 'err'); return; }
  const r = { id: uid(), name: name.slice(0, 40), seedUsd: seed, trades: {} };
  store.rounds.push(r);
  store.currentId = r.id;
  save();
  closeModal('addRoundBg');
  renderAll();
  toast('회차 추가됨 ✅', 'ok');
}
function renameRound() {
  const c = cur();
  if (!c) return;
  const name = (prompt('회차 이름', c.name) || '').trim();
  if (!name) return;
  c.name = name.slice(0, 40);
  save();
  renderAll();
}
function deleteRound() {
  const c = cur();
  if (!c) return;
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
  document.querySelectorAll('#segCurrency button').forEach(b => b.classList.toggle('active', b.dataset.v === store.opts.currency));
  openModal('optBg');
}
function saveOptions() {
  const c = cur();
  const seed = num($('optSeed').value);
  if (c && seed > 0) c.seedUsd = seed;
  save();
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
  const data = { app: 'buythedip', v: 1, exportedAt: new Date().toISOString(), opts: store.opts, rounds: store.rounds };
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
    if (d.app !== 'buythedip') throw new Error('줍줍매매 백업 파일이 아니에요');
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

// ────────── 구글 시트에서 1회 가져오기 (읽기 전용) ──────────
function normDate(s) {
  if (typeof s !== 'string' || !s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d)) return '';
  const k = new Date(d.getTime() + 9 * 3600 * 1000);       // 한국 날짜로 변환
  return k.toISOString().slice(0, 10);
}
async function sheetCall(base, action, params = {}) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const r = await fetch(base + (base.includes('?') ? '&' : '?') + qs, { redirect: 'follow' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}
async function importSheet() {
  const base = $('optScriptUrl').value.trim();
  let host = '';
  try { const u = new URL(base); host = u.protocol === 'https:' ? u.hostname : ''; } catch (e) {}
  if (host !== 'script.google.com' && host !== 'script.googleusercontent.com') {
    toast('Apps Script 웹앱 주소(https://script.google.com/...)를 넣어 주세요', 'err');
    return;
  }
  toast('시트를 읽는 중…');
  try {
    const { tabs = [] } = await sheetCall(base, 'listtabs');
    const added = [];
    for (const name of tabs) {
      let res;
      try { res = await sheetCall(base, 'read', { tab: name }); } catch (e) { continue; }   // 회차 탭이 아니면 건너뜀
      const trades = {};
      (res.rows || []).slice(0, STAGE_IDS.length).forEach((row, i) => {
        if (!row || !row.stage_used) return;
        const t = cleanTrade({ date: normDate(row.date), price: row.trade_price, qty: row.qty, fx: row.fx, fg: row.fg, vix: row.vix });
        if (t) trades[STAGE_IDS[i]] = t;
      });
      if (!Object.keys(trades).length) continue;                                           // 매매기록이 없는 탭은 건너뜀
      const seed = num(res.summary && res.summary.total_seed_usd);
      let finalName = String(name).slice(0, 40);
      if (store.rounds.some(r => r.name === finalName)) finalName = finalName.slice(0, 33) + ' (시트)';
      added.push({ id: uid(), name: finalName, seedUsd: seed > 0 ? seed : DEFAULT_SEED, trades });
    }
    if (!added.length) throw new Error('매매기록이 있는 탭을 찾지 못했어요');
    store.rounds.push(...added);
    store.currentId = added[added.length - 1].id;
    save();
    closeModal('optBg');
    renderAll();
    toast(`회차 ${added.length}개를 가져왔어요 ✅`, 'ok');
  } catch (e) {
    toast('가져오기 실패: ' + e.message, 'err');
  }
}

// ────────── 이벤트 ──────────
const ACTIONS = {
  'refresh':         () => handleRefresh(),
  'open-options':    () => openOptions(),
  'save-options':    () => saveOptions(),
  'tab':             (el) => switchTab(el.dataset.tab),
  'toggle-select':   () => $('acctSelect').classList.toggle('open'),
  'pick-round':      (el) => { store.currentId = el.dataset.id; save(); $('acctSelect').classList.remove('open'); renderAll(); },
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
  'import-sheet':    () => importSheet(),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el) {
    if (el.dataset.act === 'bg-close') { if (e.target === el) closeModal(el.dataset.close); }
    else if (ACTIONS[el.dataset.act]) ACTIONS[el.dataset.act](el);
  }
  if (!e.target.closest('#acctSelect')) $('acctSelect').classList.remove('open');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-bg.open').forEach(m => closeModal(m.id));
    $('acctSelect').classList.remove('open');
  } else if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.tab, .select, .trade-header')) {
    e.preventDefault();
    e.target.click();
  }
});
$('optDark').addEventListener('change', (e) => setTheme(e.target.checked));
$('importFile').addEventListener('change', (e) => importJson(e.target.files[0]));

// ────────── 시작 ──────────
document.querySelectorAll('.tab, .select, .trade-header').forEach(el => { el.tabIndex = 0; el.setAttribute('role', 'button'); });
load();
document.documentElement.setAttribute('data-theme', store.opts.theme === 'dark' ? 'dark' : '');
document.querySelectorAll('#segCurrency button').forEach(b => b.classList.toggle('active', b.dataset.v === store.opts.currency));
renderAll();
fetchMarket().then(renderAll);

})();
