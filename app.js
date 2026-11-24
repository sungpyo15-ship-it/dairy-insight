// DAIRY INSIGHT — 공식 데이터 기반 낙농 시장정보 (정적 PWA)
// 데이터: data/status.json (수집 상태) · data/auto/*.json (자동 수집) · data/manual.json (직접 입력) · data/briefs.json
const $ = (s) => document.querySelector(s);
const fmt = (n, d = 0) => (n == null || isNaN(n)) ? '—'
  : Number(n).toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const YEAR_COLORS = ['#9aa7a2', '#d08b5b', '#1f6f5c', '#3b6fb6', '#b5476a'];

let INDICATORS = [];
let currentGroup = '전체';

async function getJSON(path) {
  try {
    const r = await fetch(path, { cache: 'no-cache' });
    return r.ok ? await r.json() : null;
  } catch (_) { return null; }
}

// ---- 자동 수집 데이터 → 지표 시계열 --------------------------------------
function fromCarcass(d) {
  if (!d) return [];
  const pick = (breed, sex, field) => d.records
    .filter((r) => r.breed === breed && r.sex === sex && r[field] != null)
    .map((r) => ({ t: r.month, v: r[field] }));
  const base = { source: d.source, url: d.source_url, cycle: '월간', collected: d.collected_at };
  return [
    { id: 'cow_price', group: '젖소 도체', name: '젖소 암소 경락단가', unit: '원/kg', series: pick('젖소', '암', 'price'), note: '착유 도태우(경산우) 시세의 기준', ...base },
    { id: 'cow_count', group: '젖소 도체', name: '젖소 암소 등급판정두수', unit: '두', series: pick('젖소', '암', 'count'), note: '도태 물량 추이 — 증가 시 감산·구조조정 신호', ...base },
    { id: 'cow_weight', group: '젖소 도체', name: '젖소 암소 평균 도체중', unit: 'kg', series: pick('젖소', '암', 'weight'), ...base },
    { id: 'steer_price', group: '육우', name: '육우 거세우 경락단가', unit: '원/kg', series: pick('육우', '거세', 'price'), note: '젖소 수송아지 비육 수익성의 기준', ...base },
    { id: 'steer_count', group: '육우', name: '육우 거세우 등급판정두수', unit: '두', series: pick('육우', '거세', 'count'), ...base },
    { id: 'steer_weight', group: '육우', name: '육우 거세우 평균 도체중', unit: 'kg', series: pick('육우', '거세', 'weight'), ...base },
  ].filter((i) => i.series.length);
}

function fromSimple(d, group, name) {
  if (!d) return [];
  return [{ id: d.id, group, name, unit: d.unit, source: d.source, url: d.source_url, cycle: '월간',
    collected: d.collected_at, note: d.note, series: d.records.filter((r) => r.value != null).map((r) => ({ t: r.month, v: r.value })) }];
}

// 관세청 수입 실적(조사료·유제품): 품목별 수입량·톤당 수입단가, 품목군(category)별로 묶어 표시
function fromCustoms(d) {
  if (!d) return [];
  const hsList = [...new Set(d.records.map((r) => r.hs))];
  return hsList.flatMap((hs) => {
    const rs = d.records.filter((r) => r.hs === hs);
    const names = d.hs_names?.[hs]?.join(', ');
    const base = { group: rs[0].category || '조사료', source: `${d.source} · HS ${hs}`, url: d.source_url, cycle: '월간',
      collected: d.collected_at, note: names ? `관세청 품목명: ${names}` : '' };
    return [
      { id: `imp_t_${hs}`, name: `${rs[0].name} 수입량`, unit: '톤', series: rs.filter((r) => r.import_ton != null).map((r) => ({ t: r.month, v: r.import_ton })), ...base },
      { id: `imp_p_${hs}`, name: `${rs[0].name} 수입단가`, unit: 'USD/톤', series: rs.filter((r) => r.usd_per_ton != null).map((r) => ({ t: r.month, v: r.usd_per_ton })), ...base },
    ].filter((i) => i.series.length).concat(subSeries(rs, base));
  });
}

// 6자리 품목 안에 세부품목(10자리)이 둘 이상이면 세부품목별 수입량·단가도 따로 만든다 (예: 알팔파 건초 vs 기타 건초)
function subSeries(rs, base) {
  const codes = {};
  rs.forEach((r) => (r.subs || []).forEach((sb) => {
    const c = (codes[sb.code] = codes[sb.code] || { name: sb.name, ton: [], price: [] });
    if (sb.name) c.name = sb.name;
    if (sb.import_ton != null) c.ton.push({ t: r.month, v: sb.import_ton });
    if (sb.usd_per_ton != null) c.price.push({ t: r.month, v: sb.usd_per_ton });
  }));
  const list = Object.entries(codes).filter(([, c]) => c.ton.some((p) => p.v >= 1));
  if (list.length < 2) return [];
  return list.flatMap(([code, c]) => {
    const label = `${rs[0].name.split(' (')[0]} › ${c.name || code}`;
    const b = { ...base, source: `${base.source.split(' · HS')[0]} · HSK ${code}`, note: `세부품목 ${code}${c.name ? ' · ' + c.name : ''}` };
    return [
      { ...b, id: `sub_t_${code}`, name: `${label} 수입량`, unit: '톤', series: c.ton },
      { ...b, id: `sub_p_${code}`, name: `${label} 수입단가`, unit: 'USD/톤', series: c.price },
    ].filter((i) => i.series.length);
  });
}

// 세계은행 곡물 가격 + 원화 환산(원/kg = USD/톤 × 원/달러 ÷ 1000, 두 자료가 모두 있는 달만)
function fromGrain(d, fx) {
  if (!d) return [];
  const rate = Object.fromEntries((fx?.records || []).filter((r) => r.value != null).map((r) => [r.month, r.value]));
  const items = [...new Set(d.records.map((r) => r.item))];
  const base = { group: '국제 곡물', source: d.source, url: d.source_url, cycle: '월간', collected: d.collected_at };
  const out = items.map((it) => {
    const rs = d.records.filter((r) => r.item === it);
    return { id: 'grain_' + it, name: `${rs[0].name} 국제가격`, unit: 'USD/톤', note: `세계은행 월평균 · ${d.published || ''}`,
      series: rs.map((r) => ({ t: r.month, v: r.usd_per_ton })), ...base };
  });
  ['Maize', 'Soybean meal'].forEach((it) => {
    const rs = d.records.filter((r) => r.item === it && rate[r.month]);
    if (rs.length) out.push({ ...base, id: 'grain_krw_' + it, name: `${rs[0].name} 원화 환산`, unit: '원/kg',
      note: '세계은행 월평균 가격 × 한국은행 월평균 환율 (운임·관세·통관비 제외)',
      source: `${d.source} · 한국은행 ECOS`,
      series: rs.map((r) => ({ t: r.month, v: Math.round(r.usd_per_ton * rate[r.month] / 10) / 100 })) });
  });
  return out;
}

function fromManual(m) {
  if (!m) return [];
  return m.indicators.map((i) => ({ ...i, cycle: '수동 입력', manual: true,
    series: (i.records || []).filter((r) => r.value != null).map((r) => ({ t: r.date || r.month, v: r.value })) }));
}

async function load() {
  const status = await getJSON('data/status.json');
  // 한 번이라도 수집에 성공한 데이터셋만 불러옴 (인증키 미설정 출처는 요청하지 않음)
  const has = (id) => !!status?.datasets?.[id]?.last_success;
  const auto = (id) => (has(id) ? getJSON(`data/auto/${id}.json`) : null);
  const [carcass, usdkrw, forage, dairyImp, grain, manual, briefs] = await Promise.all([
    auto('carcass'), auto('usdkrw'), auto('forage_import'), auto('dairy_import'), auto('grain_prices'), getJSON('data/manual.json'), getJSON('data/briefs.json'),
  ]);
  const kosisIds = Object.keys(status?.datasets || {}).filter((k) => k.startsWith('kosis_') && has(k));
  const kosis = (await Promise.all(kosisIds.map((k) => getJSON(`data/auto/${k}.json`)))).filter(Boolean);

  INDICATORS = [
    ...fromManual(manual).filter((i) => i.group === '원유'),
    ...fromCarcass(carcass),
    ...fromCustoms(dairyImp),
    ...fromCustoms(forage),
    ...fromGrain(grain, usdkrw),
    ...fromSimple(usdkrw, '거시', '원/달러 환율'),
    ...fromManual(manual).filter((i) => i.group !== '원유'),
  ];
  $('#updated').textContent = status?.checked_at ? `수집 ${status.checked_at.replace(' KST', '')}` : '';
  renderChips(); renderCards(); renderTables(kosis); renderHealth(status); renderBriefs(briefs || []);
  calc();
}

// ---- 시세 카드 -------------------------------------------------------------
function change(s) {
  if (s.length < 2) return null;
  const last = s[s.length - 1].v, prev = s[s.length - 2].v, diff = last - prev;
  return { prevT: s[s.length - 2].t, diff, pct: prev ? diff / prev * 100 : 0, cls: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat', arrow: diff > 0 ? '▲' : diff < 0 ? '▼' : '–' };
}

function sparkline(s) {
  const h = s.map((p) => p.v).slice(-24);
  if (h.length < 2) return '';
  const w = 200, ht = 36, min = Math.min(...h), max = Math.max(...h), r = max - min || 1;
  const pts = h.map((v, i) => `${(i / (h.length - 1)) * w},${ht - 3 - ((v - min) / r) * (ht - 6)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${ht}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="var(--brand)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

function renderChips() {
  const groups = ['전체', ...new Set(INDICATORS.map((i) => i.group))];
  $('#groupChips').innerHTML = groups.map((g) => `<button class="${g === currentGroup ? 'active' : ''}" data-g="${esc(g)}">${esc(g)}</button>`).join('');
  $('#groupChips').onclick = (e) => {
    const g = e.target.dataset.g; if (!g) return;
    currentGroup = g; renderChips(); renderCards();
  };
}

function renderCards() {
  const list = INDICATORS.filter((i) => currentGroup === '전체' || i.group === currentGroup);
  $('#cards').innerHTML = list.map((i) => {
    if (!i.series.length) {
      return `<div class="card empty"><div class="g">${esc(i.group)} · ${esc(i.cycle)}</div><div class="n">${esc(i.name)}</div>
        <div class="v muted">미입력</div><div class="d flat">data/manual.json에 공식 발표값 입력 필요</div></div>`;
    }
    const last = i.series[i.series.length - 1], c = change(i.series);
    return `<button class="card" data-id="${esc(i.id)}">
      <div class="g">${esc(i.group)} · ${esc(last.t)}</div>
      <div class="n">${esc(i.name)}</div>
      <div><span class="v">${fmt(last.v, ['원', '원/kg'].includes(i.unit) && last.v < 10000 ? 1 : 0)}</span><span class="u">${esc(i.unit)}</span></div>
      ${c ? `<div class="d ${c.cls}">${esc(c.prevT)} 대비 ${c.arrow} ${fmt(Math.abs(c.diff), i.unit === '원' ? 1 : 0)} (${c.pct >= 0 ? '+' : ''}${fmt(c.pct, 1)}%)</div>` : '<div class="d flat">비교 자료 없음</div>'}
      ${sparkline(i.series)}
    </button>`;
  }).join('') || '<p class="hint">표시할 데이터가 없습니다. 수집 상태를 확인하세요.</p>';
  $('#cards').onclick = (e) => {
    const card = e.target.closest('button.card'); if (!card) return;
    showDetail(INDICATORS.find((i) => i.id === card.dataset.id));
  };
}

// 연도별 겹쳐보기: 가로축 1~12월, 연도마다 다른 색
function yearChart(ind) {
  const byYear = {};
  ind.series.forEach((p) => {
    const [y, m] = String(p.t).split('-');
    if (!m) return;
    (byYear[y] = byYear[y] || [])[+m - 1] = p.v;
  });
  const years = Object.keys(byYear).sort().slice(-YEAR_COLORS.length);
  const vals = years.flatMap((y) => byYear[y].filter((v) => v != null));
  if (!vals.length) return '';
  const w = 640, ht = 260, p = { l: 80, r: 14, t: 14, b: 36 };
  const min = Math.min(...vals), max = Math.max(...vals), pad = (max - min) * 0.1 || Math.abs(max) * 0.05 || 1;
  const lo = min - pad, hi = max + pad;
  const x = (i) => p.l + (i / 11) * (w - p.l - p.r);
  const y = (v) => p.t + (1 - (v - lo) / (hi - lo)) * (ht - p.t - p.b);
  const ticks = [lo, (lo + hi) / 2, hi];
  let svg = ticks.map((t) => `<line x1="${p.l}" x2="${w - p.r}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)"/><text x="${p.l - 8}" y="${y(t) + 6}" text-anchor="end">${fmt(t)}</text>`).join('');
  svg += Array.from({ length: 12 }, (_, i) => `<text x="${x(i)}" y="${ht - 8}" text-anchor="middle">${i + 1}</text>`).join('');
  const colorOf = (yi) => YEAR_COLORS[YEAR_COLORS.length - years.length + yi];
  years.forEach((yr, yi) => {
    const col = colorOf(yi), arr = byYear[yr];
    let seg = [];
    const flush = () => { if (seg.length > 1) svg += `<polyline points="${seg.join(' ')}" fill="none" stroke="${col}" stroke-width="${yi === years.length - 1 ? 3 : 2}"/>`; seg = []; };
    for (let i = 0; i < 12; i++) {
      if (arr[i] == null) { flush(); continue; } // 미발표 월은 빈칸
      seg.push(`${x(i)},${y(arr[i])}`);
      svg += `<circle cx="${x(i)}" cy="${y(arr[i])}" r="3.5" fill="${col}"><title>${yr}-${String(i + 1).padStart(2, '0')}: ${fmt(arr[i], 1)} ${esc(ind.unit)}</title></circle>`;
    }
    flush();
  });
  $('#detailLegend').innerHTML = years.map((yr, yi) => `<span><i style="background:${colorOf(yi)}"></i>${yr}년</span>`).join('');
  return `<svg viewBox="0 0 ${w} ${ht}">${svg}</svg>`;
}

function showDetail(ind) {
  $('#detailTitle').textContent = `${ind.name} (${ind.unit})`;
  $('#detailChart').innerHTML = yearChart(ind);
  const link = ind.url ? ` · <a href="${esc(ind.url)}" target="_blank" rel="noopener">원자료</a>` : '';
  $('#detailSrc').innerHTML = `${ind.note ? esc(ind.note) + '<br>' : ''}출처: ${esc(ind.source)}${link} · 미발표 월은 빈칸 · 임의 보정 없음`;
  $('#detail').hidden = false;
  $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('#detailClose').onclick = () => { $('#detail').hidden = true; };

// KOSIS 통계표: 분류 구성이 표마다 달라 최신 시점 원표를 그대로 보여줌
function renderTables(list) {
  $('#tables').innerHTML = list.map((d) => {
    const last = d.records.reduce((a, r) => (r.period > a ? r.period : a), '');
    const rows = d.records.filter((r) => r.period === last).slice(0, 60);
    return `<details class="panel"><summary>${esc(d.title)} <span class="muted">(${esc(last)})</span></summary>
      <div class="tbl"><table><thead><tr><th>구분</th><th>항목</th><th>값</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc([r.c1, r.c2, r.c3].filter(Boolean).join(' · '))}</td><td>${esc(r.item)}</td><td class="num">${fmt(r.value, 1)} ${esc(r.unit || '')}</td></tr>`).join('')}
      </tbody></table></div><p class="src">출처: <a href="${esc(d.source_url)}" target="_blank" rel="noopener">${esc(d.source)}</a></p></details>`;
  }).join('');
}

function renderHealth(status) {
  const map = { ok: ['정상', 'ok'], no_key: ['인증키 필요', 'warn'], error: ['오류(기존 자료 유지)', 'err'] };
  const ds = status?.datasets || {};
  $('#health').innerHTML = `<p class="hint">마지막 점검: ${esc(status?.checked_at || '—')}</p><ul class="health-list">` +
    Object.values(ds).map((e) => {
      const [label, cls] = map[e.state] || ['—', 'warn'];
      return `<li><span class="badge ${cls}">${label}</span> ${esc(e.label)}<br><small>최신 ${esc(e.latest_period || '—')} · ${esc(e.message || '')}</small></li>`;
    }).join('') + '</ul>';
}

function renderBriefs(briefs) {
  $('#briefs').innerHTML = briefs.length ? briefs.map((b) => `<article class="brief">
    <div class="meta"><span class="tag">${esc(b.tag)}</span>${esc(b.date)}</div>
    <h3>${esc(b.title)}</h3><p>${esc(b.body)}</p></article>`).join('')
    : '<div class="panel"><h2>주간 시황</h2><p class="hint">아직 발행된 시황이 없습니다. data/briefs.json에 작성하면 여기에 표시됩니다.</p></div>';
}

// ---- 계산기 ---------------------------------------------------------------
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

// ---- 상담 신청 (서버 미연동 — 운영 시 구글폼/CRM 연결) --------------------
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

// ---- 탭 --------------------------------------------------------------------
document.querySelector('.tabs').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.view').forEach((x) => x.classList.toggle('active', x.id === 'view-' + b.dataset.view));
  window.scrollTo(0, 0);
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
load().catch((err) => { $('#cards').textContent = '데이터를 불러오지 못했습니다: ' + err.message; });
