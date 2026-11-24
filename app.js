// DAIRY INSIGHT — 공식 데이터 기반 낙농 시장정보 (정적 PWA)
// 데이터: data/status.json (수집 상태) · data/auto/*.json (자동 수집) · data/manual.json (직접 입력) · data/briefs.json
const $ = (s) => document.querySelector(s);
const fmt = (n, d = 0) => (n == null || isNaN(n)) ? '—'
  : Number(n).toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const YEAR_COLORS = ['#9aa7a2', '#d08b5b', '#1f6f5c', '#3b6fb6', '#b5476a'];

let INDICATORS = [];

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
function fromCustoms(d, fx) {
  const rate = fxMap(fx);
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
      krwSeries(`imp_k_${hs}`, `${rs[0].name} 원화 수입원가`, rs.map((r) => ({ t: r.month, v: r.usd_per_ton })), rate, base, base.group),
    ].filter((i) => i && i.series.length).concat(subSeries(rs, base, rate));
  });
}

// 6자리 품목 안에 세부품목(10자리)이 둘 이상이면 세부품목별 수입량·단가도 따로 만든다 (예: 알팔파 건초 vs 기타 건초)
function fxMap(fx) {
  return Object.fromEntries((fx?.records || []).filter((r) => r.value != null).map((r) => [r.month, r.value]));
}

// 원화 수입원가(원/kg) = 톤당 수입단가(USD, CIF) × 월평균 환율 ÷ 1000 — 조사료만, 환율이 있는 달만
function krwSeries(id, name, usdSeries, rate, base, category) {
  if (category !== '조사료') return null;
  const series = usdSeries.filter((p) => p.v != null && rate[p.t]).map((p) => ({ t: p.t, v: Math.round(p.v * rate[p.t] / 10) / 100 }));
  return { ...base, id, name, unit: '원/kg', series, source: `${base.source} · 한국은행 ECOS 환율`,
    note: '관세청 신고 수입단가(CIF) × 월평균 원/달러 환율. 관세·통관·내륙운송비·유통마진 제외' };
}

function subSeries(rs, base, rate = {}) {
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
    const b = { ...base, sub: true, source: `${base.source.split(' · HS')[0]} · HSK ${code}`, note: `세부품목 ${code}${c.name ? ' · ' + c.name : ''}` };
    return [
      { ...b, id: `sub_t_${code}`, name: `${label} 수입량`, unit: '톤', series: c.ton },
      { ...b, id: `sub_p_${code}`, name: `${label} 수입단가`, unit: 'USD/톤', series: c.price },
      krwSeries(`sub_k_${code}`, `${label} 원화 수입원가`, c.price, rate, b, base.group),
    ].filter((i) => i && i.series.length);
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

// 미국 건초 생산자물가지수 (BLS PPI)
function fromUsHay(d) {
  if (!d) return [];
  return [...new Set(d.records.map((r) => r.series))].map((sid) => {
    const rs = d.records.filter((r) => r.series === sid);
    return { id: 'ushay_' + sid, group: '해외 조사료', name: rs[0].name, unit: '지수', cycle: '월간',
      source: `${d.source} · ${sid}`, url: `https://fred.stlouisfed.org/series/${sid}`, collected: d.collected_at,
      note: '1982=100 기준 지수(가격 아님). 미국 현지 건초 가격 흐름 참고용 — 수출용 건초 가격과는 차이가 있음',
      series: rs.map((r) => ({ t: r.month, v: r.value })) };
  });
}

// KREI 축산관측 젖소 (분기): 기간 'YYYY-Qn' → 분기말 월 'YYYY-MM'로 바꿔 연도별 차트에 배치
const qToMonth = (p) => { const [y, q] = p.split('-Q'); return `${y}-${String(q * 3).padStart(2, '0')}`; };
function fromKrei(d) {
  if (!d) return [];
  const base = { cycle: '분기', source: d.source, url: d.source_url, collected: d.collected_at,
    note: `${d.latest_issue} 기준 · ${d.method}` };
  const mk = (rows, key, id, group, name, unit) => ({ ...base, id, group, name, unit,
    series: rows.filter((r) => r[key] != null).map((r) => ({ t: qToMonth(r.period), v: r[key] })) });
  const sup = d.supply || [], herd = d.herd || [];
  const out = [
    mk(sup, 'production', 'krei_prod', '원유 수급', '원유 국내 생산량', '천 톤'),
    mk(sup, 'consumption', 'krei_cons', '원유 수급', '유제품 국내 소비량 (원유 환산)', '천 톤'),
    mk(sup, 'import', 'krei_imp', '원유 수급', '유제품 수입량 (원유 환산)', '천 톤'),
    mk(sup, 'stock', 'krei_stock', '원유 수급', '분기말 재고 (원유 환산)', '천 톤'),
    mk(herd, 'total', 'krei_herd', '젖소 사육', '젖소 총 사육 마릿수', '천 마리'),
    mk(herd, 'milking', 'krei_milking', '젖소 사육', '착유우 마릿수', '천 마리'),
    mk(herd, 'births', 'krei_births', '젖소 사육', '송아지 생산 마릿수 (분기)', '천 마리'),
  ];
  const feed = d.feed || [];
  const feedNote = { note: `원자료: 농림축산식품부 · ${base.note}` };
  out.push(
    { ...mk(feed, 'total', 'krei_feed_total', '배합사료', '젖소용 배합사료 생산량 (분기)', '천 톤'), ...feedNote },
    { ...mk(feed, 'milking', 'krei_feed_milk', '배합사료', '착유우용 배합사료 생산량 (분기)', '천 톤'), ...feedNote },
    { ...mk(feed, 'calf', 'krei_feed_calf', '배합사료', '송아지용 배합사료 생산량 (분기)', '천 톤'), ...feedNote },
  );
  const sl = d.slaughter || [];
  if (sl.length) out.push({ ...base, id: 'krei_slaughter', group: '젖소 사육', name: '젖소 도축 마릿수 (월)', unit: '마리', cycle: '월간',
    note: `원자료: 농림축산검역본부 · 보고서마다 최근 2개월씩 실려 매 분기 누적 · ${base.note}`,
    series: sl.map((r) => ({ t: r.period, v: r.head })) });
  const items = [...new Set((d.prices || []).map((r) => r.item))];
  items.forEach((it) => {
    const rs = (d.prices || []).filter((r) => r.item === it);
    out.push({ ...base, id: 'krei_price_' + it, group: '젖소 산지가격', name: `${rs[0].name} 산지가격 (분기 평균)`, unit: '원/마리',
      series: rs.map((r) => ({ t: qToMonth(r.period), v: r.won })) });
  });
  return out.filter((i) => i.series.length);
}

function fromManual(m) {
  if (!m) return [];
  return m.indicators.map((i) => ({ ...i, cycle: '수동 입력', manual: true,
    series: (i.records || []).filter((r) => r.value != null).map((r) => ({ t: r.date || r.month, v: r.value })) }));
}

// ---- 화면 구성: 섹션 → 소제목(목차) → 지표 카드 -------------------------------
// 지표의 group을 소제목에 배치한다. 목록에 없는 group은 자동으로 '기타'에 붙는다.
const SECTIONS = {
  milk: { title: '원유·유제품', lead: '원유 생산·소비·재고와 유제품 수입 동향', subs: [
    { id: 'm-supply', title: '원유 수급', desc: '국내 생산·소비·재고 (원유 환산, 분기) · 원유 기본가격', groups: ['원유 수급', '원유'] },
    { id: 'm-milk', title: '우유·멸균유 수입', desc: '관세청 월별 수입량·톤당 수입단가', groups: ['우유·멸균유'] },
    { id: 'm-powder', title: '분유 수입', desc: '탈지·전지·가당·조제분유', groups: ['분유'] },
    { id: 'm-whey', title: '유청·대용유 원료 수입', desc: '유장·유장분말 (사료용 포함)', groups: ['유청·대용유 원료'] },
    { id: 'm-butter', title: '버터·치즈 수입', desc: '버터, 모차렐라 등 신선치즈, 체다·고다 등', groups: ['버터·치즈'] },
  ] },
  cattle: { title: '젖소·가축', lead: '젖소 사육 규모, 도축, 도체 시세와 산지가격', subs: [
    { id: 'c-herd', title: '젖소 사육·도축', desc: '사육 마릿수·착유우·송아지 생산(분기), 도축 마릿수(월)', groups: ['젖소 사육'] },
    { id: 'c-price', title: '젖소 산지가격', desc: '분유떼기 암송아지·초임만삭우·초산우·노폐우 (분기 평균)', groups: ['젖소 산지가격', '가축'] },
    { id: 'c-carcass', title: '젖소 도체 시세', desc: '암소 경락단가·판정두수·도체중 (월)', groups: ['젖소 도체'] },
    { id: 'c-beef', title: '육우', desc: '육우 거세우 경락단가·판정두수·도체중 (월)', groups: ['육우'] },
  ] },
  feed: { title: '사료·조사료', lead: '배합사료 생산, 조사료 수입원가, 국제 곡물과 환율', subs: [
    { id: 'f-mixed', title: '배합사료 생산', desc: '젖소용·착유우용·송아지용 (분기)', groups: ['배합사료'] },
    { id: 'f-forage', title: '조사료 수입', desc: '건초류·곡물 짚·알팔파 펠릿 수입량·단가·원화 수입원가', groups: ['조사료'] },
    { id: 'f-ushay', title: '해외 조사료', desc: '미국 알팔파·기타 건초 생산자물가지수', groups: ['해외 조사료'] },
    { id: 'f-grain', title: '국제 곡물', desc: '옥수수·대두박·대두·밀 국제가격과 원화 환산', groups: ['국제 곡물'] },
    { id: 'f-fx', title: '환율', desc: '원/달러 월평균', groups: ['거시'] },
  ] },
};
// 홈 '핵심 지표' (있는 것만 순서대로 표시)
const HOME_KPIS = ['krei_prod', 'krei_milking', 'cow_price', 'krei_price_cull_cow', 'krei_feed_total',
  'imp_k_121490', 'grain_krw_Maize', 'usdkrw'];

let BY_ID = {};

async function load() {
  const status = await getJSON('data/status.json');
  // 한 번이라도 수집에 성공한 데이터셋만 불러옴 (인증키 미설정 출처는 요청하지 않음)
  const has = (id) => !!status?.datasets?.[id]?.last_success;
  const auto = (id) => (has(id) ? getJSON(`data/auto/${id}.json`) : null);
  const [carcass, usdkrw, forage, dairyImp, grain, usHay, krei, manual, briefs] = await Promise.all([
    auto('carcass'), auto('usdkrw'), auto('forage_import'), auto('dairy_import'), auto('grain_prices'),
    auto('us_hay_ppi'), auto('krei_dairy'), getJSON('data/manual.json'), getJSON('data/briefs.json'),
  ]);
  const kosisIds = Object.keys(status?.datasets || {}).filter((k) => k.startsWith('kosis_') && has(k));
  const kosis = (await Promise.all(kosisIds.map((k) => getJSON(`data/auto/${k}.json`)))).filter(Boolean);

  INDICATORS = [
    ...fromManual(manual).filter((i) => i.group === '원유'),
    ...fromKrei(krei),
    ...fromCarcass(carcass),
    ...fromCustoms(dairyImp, usdkrw),
    ...fromCustoms(forage, usdkrw),
    ...fromUsHay(usHay),
    ...fromGrain(grain, usdkrw),
    ...fromSimple(usdkrw, '거시', '원/달러 환율'),
    ...fromManual(manual).filter((i) => i.group !== '원유'),
  ];
  BY_ID = Object.fromEntries(INDICATORS.map((i) => [i.id, i]));
  $('#stamp').textContent = status?.checked_at ? `자료 점검 ${status.checked_at} · 매일 자동 갱신` : '';
  renderHome();
  Object.keys(SECTIONS).forEach(renderSection);
  renderTables(kosis); renderHealth(status); renderBriefs(briefs || []);
  calc();
  routeFromHash();
}

// ---- 카드 -----------------------------------------------------------------
const tLabel = (i, t) => (i.cycle === '분기' ? `${t.slice(0, 4)}년 ${Math.ceil(+t.slice(5, 7) / 3)}분기` : t);
const digits = (i, v) => (['원', '원/kg'].includes(i.unit) && Math.abs(v) < 10000 ? 1 : 0);

function change(s) {
  if (s.length < 2) return null;
  const last = s[s.length - 1].v, prev = s[s.length - 2].v, diff = last - prev;
  return { prevT: s[s.length - 2].t, diff, pct: prev ? diff / prev * 100 : 0,
    cls: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat', arrow: diff > 0 ? '▲' : diff < 0 ? '▼' : '–' };
}

function sparkline(s) {
  const h = s.map((p) => p.v).slice(-24);
  if (h.length < 2) return '';
  const w = 200, ht = 36, min = Math.min(...h), max = Math.max(...h), r = max - min || 1;
  const pts = h.map((v, i) => `${(i / (h.length - 1)) * w},${ht - 3 - ((v - min) / r) * (ht - 6)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${ht}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--brand)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

function card(i, { showGroup = false } = {}) {
  if (!i.series.length) {
    return `<div class="card empty"><div class="g">${esc(showGroup ? i.group + ' · ' : '')}${esc(i.cycle)}</div><div class="n">${esc(i.name)}</div>
      <div class="v muted">미입력</div><div class="d flat">공식 발표값 입력 예정</div></div>`;
  }
  const last = i.series[i.series.length - 1], c = change(i.series);
  return `<button class="card" data-id="${esc(i.id)}">
    <div class="g">${esc(showGroup ? i.group + ' · ' : '')}${esc(tLabel(i, last.t))}</div>
    <div class="n">${esc(i.name)}</div>
    <div class="vrow"><span class="v">${fmt(last.v, digits(i, last.v))}</span><span class="u">${esc(i.unit)}</span></div>
    ${c ? `<div class="d ${c.cls}">${c.arrow} ${fmt(Math.abs(c.diff), digits(i, c.diff))} (${c.pct >= 0 ? '+' : ''}${fmt(c.pct, 1)}%) <span class="muted">· ${esc(tLabel(i, c.prevT))} 대비</span></div>` : '<div class="d flat">비교 자료 없음</div>'}
    ${sparkline(i.series)}
  </button>`;
}

// ---- 홈 -------------------------------------------------------------------
function renderHome() {
  const kpis = HOME_KPIS.map((id) => BY_ID[id]).filter((i) => i && i.series.length);
  $('#homeKpis').innerHTML = kpis.map((i) => card(i, { showGroup: true })).join('') || '<p class="hint">자료를 불러오는 중입니다.</p>';
  $('#homeToc').innerHTML = Object.entries(SECTIONS).map(([key, s]) => {
    const n = INDICATORS.filter((i) => s.subs.some((sb) => sb.groups.includes(i.group)) && !i.sub && i.series.length).length;
    return `<a class="toc-card" href="#${key}">
      <span class="toc-title">${esc(s.title)}</span>
      <span class="toc-lead">${esc(s.lead)}</span>
      <span class="toc-items">${s.subs.map((sb) => esc(sb.title)).join(' · ')}</span>
      <span class="toc-count">지표 ${n}개 →</span></a>`;
  }).join('') + `<a class="toc-card alt" href="#more">
      <span class="toc-title">더보기</span>
      <span class="toc-lead">유대·IOFC 계산기, 주간 시황, 상담 신청, 통계표</span>
      <span class="toc-count">열기 →</span></a>`;
}

// ---- 섹션 (목차 + 소제목별 카드) --------------------------------------------
function renderSection(key) {
  const s = SECTIONS[key];
  const known = new Set(Object.values(SECTIONS).flatMap((x) => x.subs.flatMap((sb) => sb.groups)));
  const subs = s.subs.map((sb) => ({ ...sb, items: INDICATORS.filter((i) => sb.groups.includes(i.group)) }))
    .filter((sb) => sb.items.length);
  if (key === 'feed') { // 어느 소제목에도 속하지 않은 지표는 마지막 섹션 '기타'로
    const rest = INDICATORS.filter((i) => !known.has(i.group));
    if (rest.length) subs.push({ id: 'f-etc', title: '기타', desc: '', items: rest });
  }
  const html = `<div class="view-head">
      <h1>${esc(s.title)}</h1><p class="lead">${esc(s.lead)}</p>
    </div>
    <nav class="toc" aria-label="${esc(s.title)} 목차">${subs.map((sb) => `<a href="#${sb.id}">${esc(sb.title)}</a>`).join('')}</nav>` + subs.map((sb) => {
      const main = sb.items.filter((i) => !i.sub && i.series.length), detail = sb.items.filter((i) => i.sub && i.series.length);
      const empty = sb.items.filter((i) => !i.series.length);
      return `<section class="block" id="${sb.id}">
        <h2 class="sec-title">${esc(sb.title)}</h2>${sb.desc ? `<p class="sec-desc">${esc(sb.desc)}</p>` : ''}
        <div class="cards">${main.map((i) => card(i)).join('')}</div>
        ${empty.length ? `<p class="pending">입력 예정: ${empty.map((i) => esc(i.name)).join(', ')} <span class="muted">(공식 발표값 확인 후 반영)</span></p>` : ''}
        ${detail.length ? `<details class="more-items"><summary>세부품목 ${detail.length}개 보기</summary>
          <div class="cards">${detail.map((i) => card(i)).join('')}</div></details>` : ''}
      </section>`;
    }).join('') || '<p class="hint">아직 수집된 자료가 없습니다.</p>';
  $('#view-' + key).innerHTML = html;
  watchToc($('#view-' + key));
}

// 스크롤 위치에 맞춰 목차 칩 강조 + 칩 줄을 가로로 따라 이동
const tocObservers = [];
function watchToc(view) {
  const links = [...view.querySelectorAll('.toc a')];
  if (!links.length || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries) => {
    entries.filter((en) => en.isIntersecting).forEach((en) => {
      links.forEach((a) => {
        const on = a.getAttribute('href') === '#' + en.target.id;
        a.classList.toggle('on', on);
        if (on) a.scrollIntoView({ block: 'nearest', inline: 'center' });
      });
    });
  }, { rootMargin: '-120px 0px -60% 0px' });
  view.querySelectorAll('section.block').forEach((sec) => io.observe(sec));
  tocObservers.push(io);
}

// 카드 클릭 → 상세 시트 (모든 화면 공통)
document.addEventListener('click', (e) => {
  const c = e.target.closest('button.card');
  if (c && BY_ID[c.dataset.id]) openSheet(BY_ID[c.dataset.id]);
  const close = e.target.closest('[data-close]');
  if (close) hideSheet(close.dataset.close);
});

// ---- 상세 시트: 연도별 겹쳐보기 차트 + 최근 값 표 -----------------------------
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
  const w = 640, ht = 300, p = { l: 86, r: 16, t: 16, b: 40 };
  const min = Math.min(...vals), max = Math.max(...vals), pad = (max - min) * 0.1 || Math.abs(max) * 0.05 || 1;
  const lo = min - pad, hi = max + pad;
  const x = (i) => p.l + (i / 11) * (w - p.l - p.r);
  const y = (v) => p.t + (1 - (v - lo) / (hi - lo)) * (ht - p.t - p.b);
  const ticks = [lo, lo + (hi - lo) / 3, lo + (hi - lo) * 2 / 3, hi];
  let svg = ticks.map((t) => `<line x1="${p.l}" x2="${w - p.r}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)"/><text x="${p.l - 10}" y="${y(t) + 7}" text-anchor="end">${fmt(t, Math.abs(hi - lo) < 10 ? 1 : 0)}</text>`).join('');
  svg += Array.from({ length: 12 }, (_, i) => `<text x="${x(i)}" y="${ht - 10}" text-anchor="middle">${i + 1}월</text>`).join('');
  const colorOf = (yi) => YEAR_COLORS[YEAR_COLORS.length - years.length + yi];
  years.forEach((yr, yi) => {
    const col = colorOf(yi), arr = byYear[yr], latest = yi === years.length - 1;
    let seg = [];
    const flush = () => { if (seg.length > 1) svg += `<polyline points="${seg.join(' ')}" fill="none" stroke="${col}" stroke-width="${latest ? 4 : 2.5}" stroke-linejoin="round"/>`; seg = []; };
    for (let i = 0; i < 12; i++) {
      if (arr[i] == null) { if (ind.cycle !== '분기') flush(); continue; } // 미발표 월은 빈칸 (분기 자료는 분기말끼리 연결)
      seg.push(`${x(i)},${y(arr[i])}`);
    }
    flush();
    for (let i = 0; i < 12; i++) if (arr[i] != null) {
      svg += `<circle cx="${x(i)}" cy="${y(arr[i])}" r="${latest ? 6 : 4}" fill="${col}" stroke="var(--card)" stroke-width="2"><title>${yr}-${String(i + 1).padStart(2, '0')}: ${fmt(arr[i], 1)} ${esc(ind.unit)}</title></circle>`;
    }
  });
  $('#sheetLegend').innerHTML = years.map((yr, yi) => `<span><i style="background:${colorOf(yi)}"></i>${yr}년</span>`).join('');
  return `<svg viewBox="0 0 ${w} ${ht}" role="img" aria-label="${esc(ind.name)} 연도별 추이">${svg}</svg>`;
}

function openSheet(ind) {
  const last = ind.series[ind.series.length - 1], c = change(ind.series);
  $('#sheetGroup').textContent = `${ind.group} · ${ind.cycle}`;
  $('#sheetTitle').textContent = ind.name;
  $('#sheetKpi').innerHTML = `<span class="v">${fmt(last.v, digits(ind, last.v))}</span><span class="u">${esc(ind.unit)}</span>
    <span class="when">${esc(tLabel(ind, last.t))}</span>
    ${c ? `<span class="d ${c.cls}">${c.arrow} ${fmt(Math.abs(c.diff), digits(ind, c.diff))} (${c.pct >= 0 ? '+' : ''}${fmt(c.pct, 1)}%)</span>` : ''}`;
  $('#sheetChart').innerHTML = yearChart(ind);
  const recent = ind.series.slice(-8).reverse();
  $('#sheetTable').innerHTML = `<table><thead><tr><th>기간</th><th class="num">값 (${esc(ind.unit)})</th></tr></thead><tbody>
    ${recent.map((p) => `<tr><td>${esc(tLabel(ind, p.t))}</td><td class="num">${fmt(p.v, digits(ind, p.v))}</td></tr>`).join('')}</tbody></table>`;
  const link = ind.url ? ` · <a href="${esc(ind.url)}" target="_blank" rel="noopener">원자료 보기</a>` : '';
  $('#sheetSrc').innerHTML = `${ind.note ? esc(ind.note) + '<br>' : ''}출처: ${esc(ind.source)}${link}<br>미발표 기간은 빈칸 · 임의 보정 없음`;
  showSheet('sheet');
}

function showSheet(id) {
  $('#sheetBackdrop').hidden = false; $('#' + id).hidden = false;
  requestAnimationFrame(() => { $('#sheetBackdrop').classList.add('on'); $('#' + id).classList.add('on'); });
  document.body.classList.add('noscroll');
  if (!history.state?.sheet) history.pushState({ sheet: id }, ''); // 휴대폰 뒤로가기로 닫기
}
function hideSheet(id, fromPop) {
  const el = $('#' + id);
  if (!el || el.hidden) return;
  el.classList.remove('on'); $('#sheetBackdrop').classList.remove('on');
  setTimeout(() => { el.hidden = true; $('#sheetBackdrop').hidden = true; }, 200);
  document.body.classList.remove('noscroll');
  if (!fromPop && history.state?.sheet) history.back();
}
$('#sheetClose').onclick = () => hideSheet('sheet');
$('#sheetBackdrop').onclick = () => { hideSheet('sheet'); hideSheet('iosGuide'); };
window.addEventListener('popstate', () => { hideSheet('sheet', true); hideSheet('iosGuide', true); });

// ---- 더보기 화면 구성 요소 ---------------------------------------------------
function renderTables(list) {
  $('#kosisTables').innerHTML = list.map((d) => {
    const last = d.records.reduce((a, r) => (r.period > a ? r.period : a), '');
    const rows = d.records.filter((r) => r.period === last).slice(0, 80);
    return `<details class="panel"><summary>${esc(d.title)} <span class="muted">(${esc(last)})</span></summary>
      <div class="tbl"><table><thead><tr><th>구분</th><th>항목</th><th class="num">값</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc([r.c1, r.c2, r.c3, r.c4].filter(Boolean).join(' · '))}</td><td>${esc(r.item)}</td><td class="num">${fmt(r.value, 1)} ${esc(r.unit || '')}</td></tr>`).join('')}
      </tbody></table></div><p class="src">출처: <a href="${esc(d.source_url)}" target="_blank" rel="noopener">${esc(d.source)}</a></p></details>`;
  }).join('') || '<p class="hint">KOSIS 인증키 등록 후 표시됩니다.</p>';
}

function renderHealth(status) {
  const map = { ok: ['정상', 'ok'], no_key: ['인증키 필요', 'warn'], error: ['오류(기존 자료 유지)', 'err'] };
  const ds = status?.datasets || {};
  $('#healthList').innerHTML = `<p class="hint">마지막 점검: ${esc(status?.checked_at || '—')}</p><ul class="health-list">` +
    Object.values(ds).map((e) => {
      const [label, cls] = map[e.state] || ['—', 'warn'];
      return `<li><span class="badge ${cls}">${label}</span> ${esc(e.label)}<br><small>최신 ${esc(e.latest_period || '—')} · ${esc(e.message || '')}</small></li>`;
    }).join('') + '</ul>';
}

function renderBriefs(briefs) {
  $('#briefs').innerHTML = briefs.length ? briefs.map((b) => `<article class="brief">
    <div class="meta"><span class="tag">${esc(b.tag)}</span>${esc(b.date)}</div>
    <h3>${esc(b.title)}</h3><p>${esc(b.body)}</p></article>`).join('')
    : '<div class="panel"><p class="hint">아직 발행된 시황이 없습니다.</p></div>';
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

// ---- 화면 이동: 하단 탭 + 주소(#milk, #m-powder 등)로 이동 -----------------------
const VIEW_OF = { home: 'home', milk: 'milk', cattle: 'cattle', feed: 'feed', more: 'more' };
function viewOfAnchor(id) {
  if (VIEW_OF[id]) return id;
  for (const [k, s] of Object.entries(SECTIONS)) if (s.subs.some((sb) => sb.id === id) || id === 'f-etc') return k;
  return document.getElementById(id)?.closest('.view')?.id.replace('view-', '') || 'home';
}
function showView(view, anchor) {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.view === view));
  document.querySelectorAll('.view').forEach((x) => x.classList.toggle('active', x.id === 'view-' + view));
  const target = anchor && document.getElementById(anchor);
  if (target && anchor !== view) target.scrollIntoView({ block: 'start' });
  else window.scrollTo(0, 0);
}
function routeFromHash() {
  const id = decodeURIComponent(location.hash.slice(1)) || 'home';
  showView(viewOfAnchor(id), id);
}
window.addEventListener('hashchange', routeFromHash);
watchToc(document.getElementById('view-more'));
document.querySelector('.tabs').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (location.hash === '#' + b.dataset.view) showView(b.dataset.view); else location.hash = b.dataset.view;
};

// ---- 앱 설치 ----------------------------------------------------------------
let deferredPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; $('#installBtn').hidden = false; });
if (isIOS && !isStandalone()) $('#installBtn').hidden = false;
$('#installBtn').onclick = async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice.catch(() => {});
    deferredPrompt = null; $('#installBtn').hidden = true;
  } else if (isIOS) {
    showSheet('iosGuide');
  } else {
    location.hash = 'install';
  }
};
window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
load().catch((err) => { $('#homeKpis').textContent = '데이터를 불러오지 못했습니다: ' + err.message; });
