// DAIRY INSIGHT — MVP (정적 PWA). 데이터: data/market.json
const $ = (s) => document.querySelector(s);
const fmt = (n, d = 0) => Number(n).toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d });
let DATA = null;
let currentGroup = '전체';

async function load() {
  const res = await fetch('data/market.json', { cache: 'no-cache' });
  DATA = await res.json();
  $('#updated').textContent = `기준일 ${DATA.meta.updatedAt}`;
  if (DATA.meta.isSample) {
    $('#notice').textContent = '⚠ ' + DATA.meta.notice;
    $('#notice').hidden = false;
  }
  renderChips();
  renderCards();
  renderBriefs();
  calc();
}

function change(h) {
  const last = h[h.length - 1], prev = h[h.length - 2];
  const diff = last - prev;
  const pct = prev ? (diff / prev) * 100 : 0;
  const cls = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
  const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '–';
  return { last, diff, pct, cls, arrow };
}

function sparkline(h) {
  const w = 200, ht = 36, min = Math.min(...h), max = Math.max(...h), r = max - min || 1;
  const pts = h.map((v, i) => `${(i / (h.length - 1)) * w},${ht - 3 - ((v - min) / r) * (ht - 6)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${ht}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="var(--brand)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

function lineChart(ind) {
  const h = ind.history, L = ind.labels, w = 640, ht = 240, p = { l: 78, r: 14, t: 14, b: 36 };
  const min = Math.min(...h), max = Math.max(...h), pad = (max - min) * 0.1 || 1;
  const lo = min - pad, hi = max + pad;
  const x = (i) => p.l + (i / (h.length - 1)) * (w - p.l - p.r);
  const y = (v) => p.t + (1 - (v - lo) / (hi - lo)) * (ht - p.t - p.b);
  const ticks = [lo, (lo + hi) / 2, hi];
  const grid = ticks.map((t) => `<line x1="${p.l}" x2="${w - p.r}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)"/><text x="${p.l - 6}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`).join('');
  const xl = L.map((l, i) => (i % 2 === 0 || i === L.length - 1) ? `<text x="${x(i)}" y="${ht - 8}" text-anchor="middle">${l}</text>` : '').join('');
  const pts = h.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const dots = h.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="var(--brand)"><title>${L[i]}: ${fmt(v)} ${ind.unit}</title></circle>`).join('');
  return `<svg viewBox="0 0 ${w} ${ht}">${grid}${xl}<polyline points="${pts}" fill="none" stroke="var(--brand)" stroke-width="2.5"/>${dots}</svg>`;
}

function renderChips() {
  const groups = ['전체', ...new Set(DATA.indicators.map((i) => i.group))];
  $('#groupChips').innerHTML = groups.map((g) => `<button class="${g === currentGroup ? 'active' : ''}" data-g="${g}">${g}</button>`).join('');
  $('#groupChips').onclick = (e) => {
    const g = e.target.dataset.g; if (!g) return;
    currentGroup = g; renderChips(); renderCards();
  };
}

function renderCards() {
  const list = DATA.indicators.filter((i) => currentGroup === '전체' || i.group === currentGroup);
  $('#cards').innerHTML = list.map((i) => {
    const c = change(i.history);
    return `<button class="card" data-id="${i.id}">
      <div class="g">${i.group} · ${i.cycle}</div>
      <div class="n">${i.name}</div>
      <div><span class="v">${fmt(c.last)}</span><span class="u">${i.unit}</span></div>
      <div class="d ${c.cls}">${c.arrow} ${fmt(Math.abs(c.diff))} (${c.pct >= 0 ? '+' : ''}${fmt(c.pct, 1)}%)</div>
      ${sparkline(i.history)}
    </button>`;
  }).join('');
  $('#cards').onclick = (e) => {
    const card = e.target.closest('.card'); if (!card) return;
    const ind = DATA.indicators.find((i) => i.id === card.dataset.id);
    $('#detailTitle').textContent = `${ind.name} (${ind.unit})`;
    $('#detailChart').innerHTML = lineChart(ind);
    $('#detailSrc').textContent = `출처: ${ind.source} · 갱신주기: ${ind.cycle}`;
    $('#detail').hidden = false;
    $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
}
$('#detailClose').onclick = () => { $('#detail').hidden = true; };

function renderBriefs() {
  $('#briefs').innerHTML = DATA.briefs.map((b) => `<article class="brief">
    <div class="meta"><span class="tag">${b.tag}</span>${b.date}</div>
    <h3>${b.title}</h3><p>${b.body}</p></article>`).join('');
}

// 계산기
const v = (id) => parseFloat($('#' + id).value) || 0;
function calc() {
  const heads = v('c_heads'), yieldKg = v('c_yield');
  const liters = yieldKg / 1.03; // 원유 비중 약 1.03 (kg → L)
  const p = Math.min(Math.max(v('c_procpct'), 0), 100) / 100;
  const unit = (1 - p) * (v('c_base') + v('c_incent')) + p * (v('c_proc') + v('c_incent'));
  const rev = liters * unit, feed = v('c_feed'), iofc = rev - feed;
  const feedRatio = rev ? (feed / rev) * 100 : 0;
  $('#calcResult').innerHTML = `
    평균 정산단가: <b>${fmt(unit, 1)}</b> 원/L<br>
    두당 일 유대수입: <b>${fmt(rev)}</b> 원 · 유대 대비 사료비율 <b>${fmt(feedRatio, 1)}%</b><br>
    두당 일 IOFC: <b>${fmt(iofc)}</b> 원<br>
    농장 월 IOFC (30일): <b>${fmt(iofc * heads * 30 / 10000)}</b> 만원 · 연간 <b>${fmt(iofc * heads * 365 / 1e6, 1)}</b> 백만원`;

  const addCost = v('c_addcost'), gainL = v('c_addgain') / 1.03;
  const addRev = gainL * unit, net = addRev - addCost;
  const roi = addCost ? (net / addCost) * 100 : 0;
  const breakeven = unit ? (addCost / unit) * 1.03 : 0;
  $('#addResult').innerHTML = `
    두당 일 추가수입: <b>${fmt(addRev)}</b> 원 − 비용 ${fmt(addCost)} 원 = 순이익 <b class="${net >= 0 ? 'up' : 'down'}">${fmt(net)}</b> 원<br>
    투자수익률(ROI): <b>${fmt(roi)}%</b> · 손익분기 유량 증가: <b>${fmt(breakeven, 2)}</b> kg/두/일<br>
    농장 연간 순효과: <b>${fmt(net * heads * 365 / 10000)}</b> 만원`;
}
document.querySelectorAll('#view-calc input').forEach((el) => el.addEventListener('input', calc));

// 상담 신청 (MVP: 서버 미연동 — 운영 시 API/구글폼/CRM 연결)
$('#leadForm').onsubmit = (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  try {
    const arr = JSON.parse(localStorage.getItem('leads') || '[]');
    arr.push({ ...d, at: new Date().toISOString() });
    localStorage.setItem('leads', JSON.stringify(arr));
  } catch (_) { /* 저장 불가 환경 무시 */ }
  $('#leadResult').hidden = false;
  $('#leadResult').textContent = `${d.farm} 신청이 접수되었습니다(시제품: 서버 미연동, 기기에만 저장).`;
  e.target.reset();
};

// 탭
document.querySelector('.tabs').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.view').forEach((x) => x.classList.toggle('active', x.id === 'view-' + b.dataset.view));
  window.scrollTo(0, 0);
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
load().catch((err) => { $('#cards').textContent = '데이터를 불러오지 못했습니다: ' + err.message; });
