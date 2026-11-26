// DAIRY DIARY — 공식 데이터 기반 낙농 시장정보 (정적 PWA)
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
    return { id: 'grain_' + it, live: GRAIN_LIVE[it], name: `${rs[0].name} 국제가격`, unit: 'USD/톤', note: `세계은행 월평균 · ${d.published || ''}`,
      series: rs.map((r) => ({ t: r.month, v: r.usd_per_ton })), ...base };
  });
  ['Maize', 'Soybean meal'].forEach((it) => {
    const rs = d.records.filter((r) => r.item === it && rate[r.month]);
    if (rs.length) out.push({ ...base, id: 'grain_krw_' + it, live: GRAIN_LIVE[it], name: `${rs[0].name} 원화 환산`, unit: '원/kg',
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

// ---- KOSIS 통계표 → 지표 카드 (전국·평균 값 + 지역별·규모별·항목별 분해) ----------
const SCALE_ORDER = ['20 미만', '20~50 미만', '50~100 미만', '100 이상'];
const FARM_SIZE = ['50두미만', '50~69두', '70~99두', '100두이상'];
const COST_ITEMS = ['사료비', '가축상각비', '자가노동비', '고용노동비', '농구비', '수도광열비', '영농시설비',
  '방역치료비', '차입금이자', '자본용역비'];
// 시도 약칭
const REGION_SHORT = { 서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천', 광주광역시: '광주', 대전광역시: '대전',
  울산광역시: '울산', 세종특별자치시: '세종', 경기도: '경기', 강원특별자치도: '강원', 강원도: '강원', 충청북도: '충북', 충청남도: '충남',
  전북특별자치도: '전북', 전라북도: '전북', 전라남도: '전남', 경상북도: '경북', 경상남도: '경남', 제주특별자치도: '제주', 전남광주통합특별시: '전남광주(통합)' };
const region = (n) => REGION_SHORT[n] || REGION_SHORT[n.replace(/도도$/, '도')] || n;
// 행정구역 통합 과도기: '전남광주통합' 행이 전남+광주 합계와 함께 실리면 중복이므로 제외
const dropMerged = (rows) => (rows.some((r) => r.c1 === '전라남도') ? rows.filter((r) => r.c1 !== '전남광주통합특별시') : rows);
const kosisT = (p) => (p.length === 6 ? `${p.slice(0, 4)}-${String(+p.slice(4) * 3).padStart(2, '0')}` : p); // 분기 YYYYQQ → 분기말 월
const latestOf = (rows) => rows.reduce((a, r) => (r.period > a ? r.period : a), '');
const kosisBase = (d, cycle) => ({ cycle, source: `${d.source} · ${d.title}`, url: d.source_url, collected: d.collected_at });

function fromKosis(K) {
  const out = [];
  const herd = K.kosis_dairy_herd;
  if (herd) {
    const R = herd.records, base = { ...kosisBase(herd, '분기'), group: '젖소 농장' };
    const nat = (item, c2) => R.filter((r) => r.c1 === '전국' && r.c2 === c2 && r.item === item && r.value != null)
      .sort((a, b) => a.period.localeCompare(b.period));
    const last = latestOf(R), lastLabel = tLabel({ cycle: '분기' }, kosisT(last));
    const bd = (item) => [
      { title: `사육 규모별 (${lastLabel})`, rows: SCALE_ORDER.map((c2) => ({ label: c2.replace(' 미만', '두 미만').replace(' 이상', '두 이상'),
        v: R.find((r) => r.c1 === '전국' && r.c2 === c2 && r.item === item && r.period === last)?.value })) },
      { title: `시도별 (${lastLabel})`, sort: true, rows: dropMerged(R.filter((r) => r.c1 !== '전국' && r.c2 === '합계' && r.item === item && r.period === last && r.value > 0))
        .map((r) => ({ label: region(r.c1), v: r.value })) },
    ];
    const farms = nat('농장수', '합계'), heads = nat('마릿수', '합계'), big = nat('마릿수', '100 이상');
    out.push(
      { ...base, id: 'kosis_farms', name: '젖소 사육 농장 수 (전국)', unit: '호', series: farms.map((r) => ({ t: kosisT(r.period), v: r.value })), breakdowns: bd('농장수') },
      { ...base, id: 'kosis_heads', name: '젖소 사육 마릿수 (이력제, 전국)', unit: '마리', series: heads.map((r) => ({ t: kosisT(r.period), v: r.value })), breakdowns: bd('마릿수'),
        note: '축산물이력제 기준 — 가축동향조사(KREI 표) 마릿수와 집계 기준이 달라 차이가 있음' },
      { ...base, id: 'kosis_avg_herd', name: '농장당 평균 사육 마릿수', unit: '마리', note: '계산값 = 전국 마릿수 ÷ 농장 수',
        series: heads.map((h) => { const f = farms.find((x) => x.period === h.period); return f ? { t: kosisT(h.period), v: Math.round(h.value / f.value * 10) / 10 } : null; }).filter(Boolean) },
      { ...base, id: 'kosis_big_share', name: '100두 이상 농장의 사육 비중', unit: '%', note: '계산값 = 100두 이상 농장 마릿수 ÷ 전국 마릿수',
        series: big.map((b) => { const h = heads.find((x) => x.period === b.period); return h ? { t: kosisT(b.period), v: Math.round(b.value / h.value * 1000) / 10 } : null; }).filter(Boolean) },
    );
  }
  const milk = K.kosis_milk_supply;
  if (milk) {
    const R = milk.records, last = latestOf(R);
    out.push({ ...kosisBase(milk, '연간'), group: '원유 생산', id: 'kosis_milk_prod', name: '원유 생산량 (연간, 전국)', unit: '천 톤',
      series: R.filter((r) => r.c1 === '합계' && r.value != null).sort((a, b) => a.period.localeCompare(b.period)).map((r) => ({ t: r.period, v: Math.round(r.value / 100) / 10 })),
      breakdowns: [{ title: `시도별 (${last}년, 천 톤)`, sort: true, rows: dropMerged(R.filter((r) => r.c1 !== '합계' && r.period === last && r.value > 0))
        .map((r) => ({ label: region(r.c1), v: Math.round(r.value / 100) / 10 })) }] });
  }
  const manwon = (v) => Math.round(v / 1000) / 10; // 원 → 만원 (소수 1자리)
  const byScale = (R, c1, last) => ({ title: `사육 규모별 (${last}년, 만원/두)`, rows: FARM_SIZE.map((c2) => ({ label: c2,
    v: manwon(R.find((r) => r.c1 === c1 && r.c2 === c2 && r.period === last)?.value ?? NaN) })) });
  const avgSeries = (R, c1) => R.filter((r) => r.c1 === c1 && r.c2 === '평균' && r.value != null)
    .sort((a, b) => a.period.localeCompare(b.period)).map((r) => ({ t: r.period, v: manwon(r.value) }));
  const prof = K.kosis_dairy_profit;
  if (prof) {
    const R = prof.records, last = latestOf(R), base = { ...kosisBase(prof, '연간'), group: '목장 수익성', unit: '만원/두' };
    [['총수입(A)', 'kosis_profit_rev', '젖소 두당 총수입'], ['비용합계(C)', 'kosis_profit_cost', '젖소 두당 생산비 (비용합계)'],
      ['소득(A-B)', 'kosis_profit_income', '젖소 두당 소득'], ['순수익(A-C)', 'kosis_profit_net', '젖소 두당 순수익']].forEach(([c1, id, name]) =>
      out.push({ ...base, id, name, series: avgSeries(R, c1), breakdowns: [byScale(R, c1, last)],
        note: '전체 평균 기준 · 소득 = 총수입 − 일반비(자가노동비·자본용역비 제외), 순수익 = 총수입 − 비용합계' }));
  }
  const cost = K.kosis_dairy_cost;
  if (cost) {
    const R = cost.records, last = latestOf(R), base = { ...kosisBase(cost, '연간'), group: '생산비', unit: '만원/두' };
    const first = (c1, c2, p) => R.find((r) => r.c1 === c1 && r.c2 === c2 && r.period === p)?.value; // 이름이 겹치는 하위 항목 대비 첫 항목 사용
    const total = first('비용합계', '평균', last);
    const items = COST_ITEMS.map((c1) => ({ label: c1, v: first(c1, '평균', last) })).filter((x) => x.v != null);
    const rest = total - items.reduce((a, x) => a + x.v, 0);
    const costBreak = { title: `비용 구성 (${last}년 평균, 만원/두)`, sort: true,
      rows: [...items, ...(rest > 0 ? [{ label: '기타(차액)', v: rest }] : [])].map((x) => ({ label: x.label, v: manwon(x.v) })) };
    const feedBreak = { title: `사료비 구성 (${last}년 평균, 만원/두)`, rows: ['농후사료', 'TMR사료', '조사료'].map((c1) => ({ label: c1, v: manwon(first(c1, '평균', last) ?? NaN) })) };
    out.push(
      { ...base, id: 'kosis_cost_total', name: '젖소 두당 사육비 (비용합계)', series: avgSeries(R, '비용합계'), breakdowns: [costBreak, byScale(R, '비용합계', last)] },
      { ...base, id: 'kosis_cost_feed', name: '젖소 두당 사료비', series: avgSeries(R, '사료비'), breakdowns: [feedBreak, byScale(R, '사료비', last)] },
      { ...base, id: 'kosis_cost_conc', name: '두당 농후사료비', series: avgSeries(R, '농후사료') },
      { ...base, id: 'kosis_cost_tmr', name: '두당 TMR사료비', series: avgSeries(R, 'TMR사료') },
      { ...base, id: 'kosis_cost_rough', name: '두당 조사료비', series: avgSeries(R, '조사료') },
      { ...base, id: 'kosis_feed_share', name: '사육비 중 사료비 비중', unit: '%', note: '계산값 = 사료비 ÷ 비용합계 (전체 평균)',
        series: [...new Set(R.map((r) => r.period))].sort().map((p) => { const f = first('사료비', '평균', p), t = first('비용합계', '평균', p);
          return f && t ? { t: p, v: Math.round(f / t * 1000) / 10 } : null; }).filter(Boolean) },
    );
  }
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
    { id: 'm-prod', title: '원유 생산 (연간·시도별)', desc: '농림축산식품부 우유 생산 통계 (KOSIS)', groups: ['원유 생산'] },
    { id: 'm-milk', title: '우유·멸균유 수입', desc: '관세청 월별 수입량·톤당 수입단가', groups: ['우유·멸균유'] },
    { id: 'm-powder', title: '분유 수입', desc: '탈지·전지·가당·조제분유', groups: ['분유'] },
    { id: 'm-whey', title: '유청·대용유 원료 수입', desc: '유장·유장분말 (사료용 포함)', groups: ['유청·대용유 원료'] },
    { id: 'm-butter', title: '버터·치즈 수입', desc: '버터, 모차렐라 등 신선치즈, 체다·고다 등', groups: ['버터·치즈'] },
  ] },
  cattle: { title: '젖소·가축', lead: '젖소 사육 규모, 도축, 시세와 산지가격, 목장 수익성', subs: [
    { id: 'c-herd', title: '젖소 사육·도축', desc: '사육 마릿수·착유우·송아지 생산(분기), 도축 마릿수(월)', groups: ['젖소 사육'] },
    { id: 'c-farm', title: '젖소 농장 규모', desc: '농장 수·마릿수(이력제), 농장당 평균, 100두 이상 비중 (분기, KOSIS)', groups: ['젖소 농장'] },
    { id: 'c-price', title: '젖소 산지가격', desc: '분유떼기 암송아지·초임만삭우·초산우·노폐우 (분기 평균)', groups: ['젖소 산지가격', '가축'] },
    { id: 'c-carcass', title: '젖소 도체 시세', desc: '암소 경락단가·판정두수·도체중 (월)', groups: ['젖소 도체'] },
    { id: 'c-profit', title: '목장 수익성', desc: '젖소 두당 총수입·생산비·소득·순수익 (연간, 농축산물생산비조사)', groups: ['목장 수익성'] },
    { id: 'c-cost', title: '젖소 생산비', desc: '두당 사육비와 사료비 구성 (연간)', groups: ['생산비'] },
    { id: 'c-beef', title: '육우', desc: '육우 거세우 경락단가·판정두수·도체중 (월)', groups: ['육우'] },
  ] },
  feed: { title: '사료·조사료', lead: '배합사료 생산, 조사료 수입원가, 국제 곡물과 환율', subs: [
    { id: 'f-mixed', title: '배합사료 생산', desc: '젖소용·착유우용·송아지용 (분기)', groups: ['배합사료'] },
    { id: 'f-forage', title: '조사료 수입', desc: '건초류·곡물 짚·알팔파 펠릿 수입량·단가·원화 수입원가', groups: ['조사료'] },
    { id: 'f-ushay', title: '해외 조사료', desc: '미국 알팔파·기타 건초 생산자물가지수', groups: ['해외 조사료'] },
    { id: 'f-grain', title: '국제 곡물', desc: '옥수수·대두박·대두·밀 국제가격(월평균)과 원화 환산', groups: ['국제 곡물'], live: 'grain' },
    { id: 'f-fx', title: '환율', desc: '원/달러 월평균', groups: ['거시'], live: 'fx' },
  ] },
};
// 네이버 증권 시세 화면 바로가기 (값을 가져오지 않고 원래 화면으로 연결만 함)
const NAVER = 'https://m.stock.naver.com/marketindex/';
const LIVE_LINKS = {
  grain: [['옥수수', 'agricultural/Ccv1'], ['대두', 'agricultural/Scv1'], ['대두박', 'agricultural/SMcv1'], ['소맥(밀)', 'agricultural/Wcv1']],
  fx: [['원/달러 환율', 'exchange/FX_USDKRW']],
};
const GRAIN_LIVE = { Maize: 'agricultural/Ccv1', Soybeans: 'agricultural/Scv1', 'Soybean meal': 'agricultural/SMcv1', 'Wheat, US HRW': 'agricultural/Wcv1' };

// 홈 '핵심 지표' (있는 것만 순서대로 표시)
const HOME_KPIS = ['krei_prod', 'krei_milking', 'kosis_profit_net', 'cow_price', 'krei_price_cull_cow', 'krei_feed_total',
  'imp_k_121490', 'grain_krw_Maize'];

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
  const K = Object.fromEntries(kosis.map((d) => [d.id, d]));
  const rules = await auto('milk_rules');
  if (rules?.buyers) { RULES_SHARED = rules.buyers; if (!CS._rulesApplied && rulesFor(CS.common.buyer)) { CS._rulesApplied = true; applyRules(CS.common.buyer); } else renderCalc(); }

  INDICATORS = [
    ...fromManual(manual).filter((i) => i.group === '원유'),
    ...fromKrei(krei),
    ...fromKosis(K),
    ...fromCarcass(carcass),
    ...fromCustoms(dairyImp, usdkrw),
    ...fromCustoms(forage, usdkrw),
    ...fromUsHay(usHay),
    ...fromGrain(grain, usdkrw),
    ...fromSimple(usdkrw, '거시', '원/달러 환율').map((i) => ({ ...i, live: 'exchange/FX_USDKRW' })),
    ...fromManual(manual).filter((i) => i.group !== '원유'),
  ];
  BY_ID = Object.fromEntries(INDICATORS.map((i) => [i.id, i]));
  // 일지 첫 줄: 오늘 날짜(한국 시간)
  const kst = (o) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', ...o }).format(new Date());
  $('#diaryDate').textContent = `${kst({ year: 'numeric', month: 'long', day: 'numeric' })} (${kst({ weekday: 'short' })})`;
  $('#stamp').textContent = status?.checked_at ? `마지막 자료 점검 ${status.checked_at} · 매일 자동 갱신` : '';
  renderHome();
  Object.keys(SECTIONS).forEach(renderSection);
  renderTables(kosis); renderHealth(status); renderBriefs(briefs || []);
  routeFromHash();
}

// ---- 카드 -----------------------------------------------------------------
const tLabel = (i, t) => (i.cycle === '분기' ? `${t.slice(0, 4)}년 ${Math.ceil(+t.slice(5, 7) / 3)}분기` : i.cycle === '연간' ? `${t}년` : t);
const digits = (i, v) => ((i.unit === '원' && Math.abs(v) < 10000) || (i.unit === '원/kg' && Math.abs(v) < 1000) || ['만원/두', '%'].includes(i.unit) || (i.unit === '마리' && Math.abs(v) < 1000 && v % 1) ? 1 : 0);

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
// 홈 '오늘의 핵심 기록' 타일: 분야 색 꼬리표 + 큰 숫자 + 증감 배지 + 면적형 미니 그래프
const SECTION_TAG = { milk: ['원유·유제품', 'milk'], cattle: ['젖소·가축', 'cattle'], feed: ['사료·조사료', 'feed'] };
function sectionOf(i) {
  if (i.group === '거시') return ['환율', 'macro'];
  const key = Object.keys(SECTIONS).find((k) => SECTIONS[k].subs.some((sb) => sb.groups.includes(i.group)));
  return SECTION_TAG[key] || ['기타', 'macro'];
}
function sparkArea(s, id) {
  const h = s.map((p) => p.v).slice(-24);
  if (h.length < 2) return '';
  const w = 200, ht = 44, min = Math.min(...h), max = Math.max(...h), r = max - min || 1;
  const pts = h.map((v, k) => [k / (h.length - 1) * w, ht - 4 - ((v - min) / r) * (ht - 10)]);
  const line = pts.map((q) => q.join(',')).join(' ');
  const gid = 'g' + id.replace(/\W/g, '');
  const [lx, ly] = pts[pts.length - 1];
  return `<svg class="kpi-spark" viewBox="0 0 ${w} ${ht}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".28"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
    <polygon points="0,${ht} ${line} ${w},${ht}" fill="url(#${gid})"/>
    <polyline points="${line}" fill="none" stroke="currentColor" stroke-width="2.2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    <circle cx="${lx}" cy="${ly}" r="3.2" fill="currentColor"/></svg>`;
}
// 타일용 짧은 이름·단위: 괄호 설명 제거(기간은 위에 표시), 10만 원 이상 '원/…'은 만원 단위로
const shortName = (n) => n.replace(/\s*\([^)]*\)/g, '').trim();
function tileValue(i, v) {
  if (/^원\//.test(i.unit) && Math.abs(v) >= 100000) return [fmt(v / 10000, 1), '만' + i.unit];
  return [fmt(v, digits(i, v)), i.unit];
}
function kpiTile(i) {
  const last = i.series[i.series.length - 1], c = change(i.series), [tag, cls] = sectionOf(i);
  const [val, unit] = tileValue(i, last.v);
  return `<button class="card kpi kpi-${cls}" data-id="${esc(i.id)}">
    <span class="kpi-top"><span class="kpi-tag">${esc(tag)}</span><span class="kpi-when">${esc(tLabel(i, last.t))}</span></span>
    <span class="kpi-name">${esc(shortName(i.name))}</span>
    <span class="kpi-val">${val}<small>${esc(unit)}</small></span>
    ${c ? `<span class="kpi-chg ${c.cls}">${c.arrow} ${c.pct >= 0 ? '+' : ''}${fmt(c.pct, 1)}%</span>` : '<span class="kpi-chg flat">비교 없음</span>'}
    ${sparkArea(i.series, i.id)}
  </button>`;
}

function renderHome() {
  const kpis = HOME_KPIS.map((id) => BY_ID[id]).filter((i) => i && i.series.length);
  $('#homeKpis').innerHTML = kpis.map(kpiTile).join('') || '<p class="hint">자료를 불러오는 중입니다.</p>';
  // 목차: 일기장 장(章) 카드 — 장 번호·분야 색, 소제목 바로가기 칩, 지표 수·최근 기록 시점
  const norm = (t) => (/^\d{4}$/.test(t) ? `${t}-12` : t); // 연간 자료는 그해 12월로 비교
  $('#homeToc').innerHTML = Object.entries(SECTIONS).map(([key, s], idx) => {
    const subs = s.subs.map((sb) => ({ ...sb, items: INDICATORS.filter((i) => sb.groups.includes(i.group) && !i.sub && i.series.length) }))
      .filter((sb) => sb.items.length);
    const items = subs.flatMap((sb) => sb.items);
    const latest = items.reduce((a, i) => { const t = i.series[i.series.length - 1].t; return !a || norm(t) > norm(a.t) ? { t, i } : a; }, null);
    const cls = SECTION_TAG[key][1];
    return `<article class="chap chap-${cls}">
      <a class="chap-head" href="#${key}">
        <span class="chap-no">${String(idx + 1).padStart(2, '0')}</span>
        <span class="chap-text"><span class="chap-title">${esc(s.title)}</span><span class="chap-lead">${esc(s.lead)}</span></span>
        <span class="chap-go" aria-hidden="true">›</span>
      </a>
      <nav class="chap-subs" aria-label="${esc(s.title)} 소제목">${subs.map((sb) => `<a href="#${sb.id}">${esc(sb.title)}<b>${sb.items.length}</b></a>`).join('')}</nav>
      <p class="chap-meta">지표 ${items.length}개${latest ? ` · 최근 기록 ${esc(tLabel(latest.i, latest.t))}` : ''}</p>
    </article>`;
  }).join('') + `<article class="chap chap-more">
      <a class="chap-head" href="#more">
        <span class="chap-no">+</span>
        <span class="chap-text"><span class="chap-title">더보기</span><span class="chap-lead">목장 경영에 바로 쓰는 도구</span></span>
        <span class="chap-go" aria-hidden="true">›</span>
      </a>
      <nav class="chap-tools" aria-label="도구 바로가기">
        <a href="#calc"><span>🧮</span>유대·IOFC<br>계산기</a>
        <a href="#brief"><span>📰</span>주간<br>시황</a>
        <a href="#contact"><span>💬</span>컨설팅<br>상담 신청</a>
        <a href="#tables"><span>📊</span>KOSIS<br>통계표</a>
      </nav>
    </article>`;
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
        ${sb.live ? `<div class="live-links"><span>오늘 시세 보기 <small>네이버 증권 ↗</small></span>${LIVE_LINKS[sb.live].map(([n, path]) => `<a href="${NAVER}${path}" target="_blank" rel="noopener">${esc(n)}</a>`).join('')}</div>` : ''}
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

// 연간 자료: 가로축 연도 추이
function trendChart(ind) {
  const pts = ind.series;
  if (!pts.length) return '';
  const w = 640, ht = 280, p = { l: 86, r: 20, t: 20, b: 40 };
  const vals = pts.map((q) => q.v), min = Math.min(...vals), max = Math.max(...vals);
  const pad = (max - min) * 0.15 || Math.abs(max) * 0.05 || 1, lo = min - pad, hi = max + pad;
  const x = (i) => p.l + (pts.length === 1 ? 0.5 : i / (pts.length - 1)) * (w - p.l - p.r);
  const y = (v) => p.t + (1 - (v - lo) / (hi - lo)) * (ht - p.t - p.b);
  let svg = [lo, lo + (hi - lo) / 3, lo + (hi - lo) * 2 / 3, hi].map((t) => `<line x1="${p.l}" x2="${w - p.r}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)"/><text x="${p.l - 10}" y="${y(t) + 7}" text-anchor="end">${fmt(t, Math.abs(hi - lo) < 10 ? 1 : 0)}</text>`).join('');
  if (lo < 0 && hi > 0) svg += `<line x1="${p.l}" x2="${w - p.r}" y1="${y(0)}" y2="${y(0)}" stroke="var(--muted)" stroke-dasharray="6 6"/>`;
  svg += pts.map((q, i) => `<text x="${x(i)}" y="${ht - 10}" text-anchor="middle">${esc(String(q.t).slice(2))}</text>`).join('');
  svg += `<polyline points="${pts.map((q, i) => `${x(i)},${y(q.v)}`).join(' ')}" fill="none" stroke="var(--brand)" stroke-width="4" stroke-linejoin="round"/>`;
  svg += pts.map((q, i) => `<circle cx="${x(i)}" cy="${y(q.v)}" r="5.5" fill="var(--brand)" stroke="var(--card)" stroke-width="2"><title>${esc(q.t)}: ${fmt(q.v, 1)} ${esc(ind.unit)}</title></circle>`).join('');
  $('#sheetLegend').innerHTML = `<span><i style="background:var(--brand)"></i>연도별 (‘${esc(String(pts[0].t).slice(2))}~‘${esc(String(pts[pts.length - 1].t).slice(2))})</span>`;
  return `<svg viewBox="0 0 ${w} ${ht}" role="img" aria-label="${esc(ind.name)} 연도별 추이">${svg}</svg>`;
}

// 분해 막대: 지역별·규모별·항목별 비교
function breakdownHTML(ind) {
  return (ind.breakdowns || []).map((bd) => {
    let rows = bd.rows.filter((r) => r.v != null && !isNaN(r.v));
    if (bd.sort) rows = rows.sort((a, b) => b.v - a.v);
    if (!rows.length) return '';
    const max = Math.max(...rows.map((r) => Math.abs(r.v))) || 1;
    return `<div class="bd"><h3>${esc(bd.title)}</h3>${rows.map((r) => `<div class="bd-row">
      <span class="bd-label">${esc(r.label)}</span>
      <span class="bd-bar"><i class="${r.v < 0 ? 'neg' : ''}" style="width:${Math.max(2, Math.abs(r.v) / max * 100)}%"></i></span>
      <span class="bd-val">${fmt(r.v, Math.abs(r.v) < 100 && r.v % 1 ? 1 : 0)}</span></div>`).join('')}</div>`;
  }).join('');
}

function openSheet(ind) {
  const last = ind.series[ind.series.length - 1], c = change(ind.series);
  $('#sheetGroup').textContent = `${ind.group} · ${ind.cycle}`;
  $('#sheetTitle').textContent = ind.name;
  $('#sheetKpi').innerHTML = `<span class="v">${fmt(last.v, digits(ind, last.v))}</span><span class="u">${esc(ind.unit)}</span>
    <span class="when">${esc(tLabel(ind, last.t))}</span>
    ${c ? `<span class="d ${c.cls}">${c.arrow} ${fmt(Math.abs(c.diff), digits(ind, c.diff))} (${c.pct >= 0 ? '+' : ''}${fmt(c.pct, 1)}%)</span>` : ''}`;
  $('#sheetChart').innerHTML = ind.cycle === '연간' ? trendChart(ind) : yearChart(ind);
  $('#sheetBreak').innerHTML = breakdownHTML(ind);
  const recent = ind.series.slice(-8).reverse();
  $('#sheetTable').innerHTML = `<table><thead><tr><th>기간</th><th class="num">값 (${esc(ind.unit)})</th></tr></thead><tbody>
    ${recent.map((p) => `<tr><td>${esc(tLabel(ind, p.t))}</td><td class="num">${fmt(p.v, digits(ind, p.v))}</td></tr>`).join('')}</tbody></table>`;
  const link = ind.url ? ` · <a href="${esc(ind.url)}" target="_blank" rel="noopener">원자료 보기</a>` : '';
  $('#sheetSrc').innerHTML = `${ind.note ? esc(ind.note) + '<br>' : ''}출처: ${esc(ind.source)}${link}<br>미발표 기간은 빈칸 · 임의 보정 없음`;
  if (ind.live) $('#sheetSrc').innerHTML = `<a class="live-btn" href="${NAVER}${ind.live}" target="_blank" rel="noopener">오늘 시세 보기 (네이버 증권) ↗</a>` + $('#sheetSrc').innerHTML;
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

// ---- 유대·IOFC 계산기 (현재 vs 목표) -----------------------------------------
// 단가·배정비율·인센티브 기준은 납유처마다 다르므로 '예시 기본값'이며 사용자가 고쳐 쓴다.
// 확인된 값: 쿼터 초과분 가격 100원/L (사용자 확인)
const CALC_KEY = 'dd-calc-v1';
const CALC_DEFAULTS = {
  common: { buyer: '서울우유', quota: 1800, rDrink: 88.6, rProc: 4.5, pDrink: 1084, pProc: 882, pRest: 882, pExcess: 100, incScope: 'quota' },
  cur: { heads: 60, yield: 28, fat: 3.9, protein: 3.2, scc: 250, bact: '1A', feed: 16500, dmi: 24, young: 0 },
  tgt: { heads: 60, yield: 31, fat: 4.0, protein: 3.3, scc: 150, bact: '1A', feed: 17500, dmi: 25, young: 0 },
  // 인센티브 기준표 (원/L): 기준값 이상(또는 미만) 구간별 가감액
  inc: {
    fat: [[3.0, -103], [3.1, -41], [3.2, -30], [3.3, -20], [3.4, -10], [3.5, 0], [3.6, 10], [3.7, 20], [3.8, 56]], // 해당 값 '이상' (첫 칸은 이하)
    protein: [[0, 0], [3.0, 4], [3.1, 11], [3.2, 19]],                                                         // 해당 값 '이상'
    scc: [[200, 52], [350, 39], [500, 0], [750, 0], [Infinity, 0]],                                              // 해당 값(천) '미만'
    bact: { '1A': 52, '1B': 36, '2': 3, '3': -15, '4': 0 },
  },
  quota: { price: 620000, buy: null, rate: 6 },
  add: { cost: 400, gain: 0.8 },
  feedRows: { cur: [], tgt: [] },
};
const BUYERS = ['낙농진흥회', '서울우유', '부산우유', '빙그레', '건국우유', '남양유업', '매일유업', '비락우유', '동원', '기타'];
const BACT = ['1A', '1B', '2', '3', '4'];
let CS = loadCalc();

// ---- 유업체별 정산 기준 (공용: data/auto/milk_rules.json, 내 기기: 엑셀 직접 불러오기) ----
const RULES_LOCAL_KEY = 'dd-rules-local';
let RULES_SHARED = {};
let RULES_LOCAL = (() => { try { return JSON.parse(localStorage.getItem(RULES_LOCAL_KEY) || '{}'); } catch (_) { return {}; } })();
const rulesFor = (name) => (RULES_LOCAL[name] ? { ...RULES_LOCAL[name], origin: '내 기기에 불러온 엑셀' }
  : RULES_SHARED[name] ? { ...RULES_SHARED[name], origin: '공용 기준표' } : null);
function applyRules(name) {
  const r = rulesFor(name);
  CS.common.buyer = name;
  if (r) {
    Object.assign(CS.common, r.common);
    const inc = r.inc || {};
    if (inc.fat?.length) CS.inc.fat = inc.fat;
    if (inc.protein?.length) CS.inc.protein = inc.protein;
    if (inc.scc?.length) CS.inc.scc = inc.scc.map(([th, v]) => [th == null ? 1e12 : th, v]);
    if (inc.bact && Object.keys(inc.bact).length) CS.inc.bact = Object.fromEntries(BACT.map((g) => [g, inc.bact[g] ?? 0]));
  }
  saveCalc(); renderCalc();
}

// 엑셀(양식) → 기준 객체: collector/milk_rules.py와 같은 규칙
function parseRulesWorkbook(wb) {
  const need = ['단가', '유지방', '유단백', '체세포', '세균'];
  const miss = need.filter((n) => !wb.SheetNames.includes(n));
  if (miss.length) throw new Error(`시트 없음: ${miss.join(', ')} (양식의 시트 이름을 바꾸지 마세요)`);
  const rowsOf = (name) => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null, raw: true });
    const hi = rows.findIndex((r) => r && r.some((c) => String(c ?? '').trim() === '유업체'));
    if (hi < 0) throw new Error(`'${name}' 시트에서 '유업체' 제목 줄을 찾지 못했습니다`);
    const head = rows[hi].map((c) => String(c ?? '').replace(/\s+/g, ''));
    return rows.slice(hi + 1).filter((r) => r && String(r[0] ?? '').trim())
      .map((r) => Object.fromEntries(head.map((h, k) => [h, r[k]]).filter(([h]) => h)));
  };
  const col = (row, ...keys) => { for (const [h, v] of Object.entries(row)) if (keys.every((k) => h.includes(k))) return v; return null; };
  const n = (v) => { if (v == null || String(v).trim() === '') return null; const x = parseFloat(String(v).replace(/[,%]/g, '')); if (isNaN(x)) throw new Error(`숫자가 아닌 값: ${v}`); return x; };
  const buyers = {}, warnings = [];
  rowsOf('단가').forEach((r) => {
    const name = String(r['유업체']).trim();
    try {
      const c = { pDrink: n(col(r, '음용유가격')), pProc: n(col(r, '가공유가격')), pRest: n(col(r, '나머지')), pExcess: n(col(r, '초과분')),
        rDrink: n(col(r, '음용유배정')), rProc: n(col(r, '가공유배정')) };
      c.incScope = String(col(r, '인센티브') ?? '쿼터내').trim().startsWith('전체') ? 'all' : 'quota';
      if (c.pDrink == null || c.pExcess == null || c.rDrink == null) throw new Error('음용유 가격·쿼터 초과분 가격·음용유 배정은 꼭 입력해야 합니다');
      c.pProc ??= c.pDrink; c.pRest ??= c.pProc; c.rProc ??= 0;
      if (c.rDrink + c.rProc > 100) throw new Error('음용유+가공유 배정이 100%를 넘습니다');
      const d = col(r, '기준일');
      buyers[name] = { date: d instanceof Date ? d.toISOString().slice(0, 10) : (d ? String(d) : ''), note: String(col(r, '출처') ?? ''),
        common: c, inc: { fat: [], protein: [], scc: [], bact: {} } };
    } catch (e) { warnings.push(`[단가] ${name}: ${e.message}`); }
  });
  [['유지방', 'fat'], ['유단백', 'protein'], ['체세포', 'scc']].forEach(([sh, key]) => rowsOf(sh).forEach((r) => {
    const name = String(r['유업체']).trim(); if (!buyers[name]) return;
    try { const v = n(col(r, '가감액')); if (v != null) buyers[name].inc[key].push([n(col(r, '기준')), v]); } catch (e) { warnings.push(`[${sh}] ${name}: ${e.message}`); }
  }));
  rowsOf('세균').forEach((r) => {
    const name = String(r['유업체']).trim(); if (!buyers[name]) return;
    const g = String(col(r, '등급') ?? '').trim().toUpperCase().replace('등급', ''), v = col(r, '가감액');
    if (g && v != null) buyers[name].inc.bact[g] = n(v);
  });
  Object.values(buyers).forEach((b) => {
    b.inc.fat = b.inc.fat.filter((x) => x[0] != null).sort((a, c) => a[0] - c[0]);
    b.inc.protein = b.inc.protein.filter((x) => x[0] != null).sort((a, c) => a[0] - c[0]);
    b.inc.scc.sort((a, c) => (a[0] ?? Infinity) - (c[0] ?? Infinity));
  });
  if (!Object.keys(buyers).length) throw new Error('읽을 수 있는 유업체 기준이 없습니다. ' + warnings.join(' / '));
  return { buyers, warnings };
}

function loadScript(src) {
  return new Promise((ok, fail) => { const t = document.createElement('script'); t.src = src; t.onload = ok; t.onerror = () => fail(new Error('엑셀 읽기 도구를 불러오지 못했습니다 (인터넷 연결 확인)')); document.head.appendChild(t); });
}
async function importRulesFile(file) {
  const msg = $('#rulesMsg');
  try {
    msg.textContent = '엑셀을 읽는 중…';
    if (!window.XLSX) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const { buyers, warnings } = parseRulesWorkbook(wb);
    RULES_LOCAL = { ...RULES_LOCAL, ...buyers };
    try { localStorage.setItem(RULES_LOCAL_KEY, JSON.stringify(RULES_LOCAL)); } catch (_) { /* 무시 */ }
    const names = Object.keys(buyers);
    applyRules(names.includes(CS.common.buyer) ? CS.common.buyer : names[0]);
    $('#rulesMsg').innerHTML = `불러옴: <b>${names.map(esc).join(', ')}</b> (이 기기에만 저장)${warnings.length ? `<br><span class="down">확인 필요: ${warnings.map(esc).join(' / ')}</span>` : ''}`;
  } catch (e) { msg.innerHTML = `<span class="down">${esc(e.message)}</span>`; }
}

function loadCalc() {
  try {
    const saved = JSON.parse(localStorage.getItem(CALC_KEY) || 'null');
    if (saved) return deepMerge(structuredClone(CALC_DEFAULTS), saved);
  } catch (_) { /* 저장소 사용 불가 */ }
  return structuredClone(CALC_DEFAULTS);
}
function deepMerge(a, b) {
  for (const k in b) a[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) ? deepMerge(a[k] || {}, b[k]) : b[k];
  return a;
}
function saveCalc() { try { localStorage.setItem(CALC_KEY, JSON.stringify(CS, (k, v) => (v === Infinity ? 1e12 : v))); } catch (_) { /* 무시 */ } }

// 인센티브 산정
function incOf(sc) {
  const T = CS.inc, r1 = (x) => Math.round(x * 10) / 10;
  const step = (table, x) => { let v = table[0][1]; for (const [th, inc] of table) if (r1(x) >= th) v = inc; return v; };
  const fat = step(T.fat, sc.fat), protein = sc.protein ? step(T.protein, sc.protein) : 0;
  const scc = (T.scc.find(([th]) => sc.scc < (th >= 1e12 ? Infinity : th)) || T.scc[T.scc.length - 1])[1];
  const bact = T.bact[sc.bact] ?? 0;
  return { fat, protein, scc, bact, total: fat + protein + scc + bact };
}
// 납유량 → 음용·가공·초과 배분과 유대수입
function milkRevenue(V, quota, inc) {
  const c = CS.common;
  // 쿼터 안: 음용유 배정 → 가공유 배정 → 나머지(쿼터 안 잔여 구간) / 쿼터 밖: 초과유
  const capD = quota * c.rDrink / 100, capP = quota * c.rProc / 100, capR = Math.max(0, quota - capD - capP);
  const vd = Math.min(V, capD), vp = Math.min(Math.max(V - vd, 0), capP);
  const vr = Math.min(Math.max(V - vd - vp, 0), capR), ve = Math.max(V - vd - vp - vr, 0);
  const excInc = c.incScope === 'all' ? inc : 0;
  const rev = vd * (c.pDrink + inc) + vp * (c.pProc + inc) + vr * (c.pRest + inc) + ve * (c.pExcess + excInc);
  return { vd, vp, vr, ve, rev, avg: V ? rev / V : 0 };
}
function scenario(sc) {
  const inc = incOf(sc), V = sc.heads * sc.yield;
  const m = milkRevenue(V, CS.common.quota, inc.total);
  const feedDay = sc.heads * sc.feed, iofc = m.rev - feedDay - sc.young;
  return { sc, inc, V, ...m, feedDay, iofc,
    perHeadRev: sc.heads ? m.rev / sc.heads : 0, perHeadIofc: sc.heads ? (m.rev - feedDay) / sc.heads : 0,
    feedPerL: sc.yield ? sc.feed / sc.yield : 0, feedRatio: m.rev ? (feedDay + sc.young) / m.rev * 100 : 0,
    feedPerDM: sc.dmi ? sc.feed / sc.dmi : null, eff: sc.dmi ? sc.yield / sc.dmi : null,
    quotaPct: CS.common.quota ? V / CS.common.quota * 100 : 0 };
}

// 화면 그리기 (입력 구조는 한 번만 만들고, 결과만 다시 계산)
const num = (path, val, attrs = '') => `<input type="number" inputmode="decimal" data-path="${path}" value="${val ?? ''}" ${attrs}>`;
function renderCalc() {
  const c = CS.common;
  const rowsIn = [
    ['heads', '착유두수 (두)', 'step="1"'], ['yield', '두당 납유량 (L/일)', 'step="0.1"'], ['fat', '유지방 (%)', 'step="0.1"'],
    ['protein', '유단백 (%)', 'step="0.1"'], ['scc', '체세포수 (천/mL)', 'step="1"'], ['bact', '세균수 등급', ''],
    ['feed', '착유우 두당 사료비 (원/일)', 'step="10"'], ['dmi', '건물섭취량 (kg/두, 선택)', 'step="0.1"'], ['young', '육성·건유우 사료비 (원/일, 농장 합계)', 'step="100"'],
  ];
  const sel = (path, list, cur) => `<select data-path="${path}">${list.map((x) => `<option ${String(x) === String(cur) ? 'selected' : ''}>${x}</option>`).join('')}</select>`;
  const incRow = (key, label, unitLabel) => `<div class="inc-row"><b>${label}</b>${CS.inc[key].map(([th, v], k) =>
    `<label>${th >= 1e12 || th === Infinity ? `${CS.inc[key][k - 1][0]} 이상` : `${th}${unitLabel}`}${num(`inc.${key}.${k}.1`, v, 'step="1"')}</label>`).join('')}</div>`;
  const feedTable = (who) => {
    const rows = CS.feedRows[who].length ? CS.feedRows[who] : Array.from({ length: 5 }, () => ({}));
    CS.feedRows[who] = rows;
    return `<table class="feed-tbl"><thead><tr><th>사료명</th><th>급여량<br>kg/두</th><th>단가<br>원/kg</th><th>수분<br>%</th></tr></thead><tbody>
      ${rows.map((r, k) => `<tr><td><input data-path="feedRows.${who}.${k}.name" value="${esc(r.name || '')}" placeholder="${k === 0 ? '예: TMR 혼합사료' : ''}"></td>
        <td>${num(`feedRows.${who}.${k}.kg`, r.kg, 'step="0.1"')}</td><td>${num(`feedRows.${who}.${k}.price`, r.price, 'step="1"')}</td><td>${num(`feedRows.${who}.${k}.moist`, r.moist, 'step="1"')}</td></tr>`).join('')}
      </tbody></table>
      <div class="feed-sum" id="feedSum-${who}"></div>
      <div class="feed-actions"><button type="button" class="ghost" data-act="addrow" data-who="${who}">＋ 줄 추가</button>
        <button type="button" class="ghost strong" data-act="applyfeed" data-who="${who}">${who === 'cur' ? '현재' : '목표'}에 반영</button></div>`;
  };
  $('#calcApp').innerHTML = `
  <div class="panel calc">
    <h3 class="calc-h">① 납유 조건 <small>납유처를 고르면 등록된 정산 기준이 채워집니다</small></h3>
    ${(() => { const r = rulesFor(c.buyer); return r
      ? `<p class="rules-on">✔ <b>${esc(c.buyer)}</b> 기준 적용 · ${esc(r.origin)}${r.date ? ` · 기준일 ${esc(r.date)}` : ''}${r.note ? `<br><span class="muted">${esc(r.note)}</span>` : ''}</p>`
      : `<p class="rules-off">${esc(c.buyer)} 정산 기준이 등록되지 않아 예시값을 씁니다. 아래에서 엑셀로 불러오거나 직접 고쳐 쓰세요.</p>`; })()}
    <div class="rules-bar">
      <label class="ghost strong file-btn">엑셀 기준표 불러오기<input type="file" accept=".xlsx,.xls" id="rulesFile" hidden></label>
      <a class="ghost" href="templates/유대정산표_양식.xlsx" download>양식 내려받기</a>
      ${Object.keys(RULES_LOCAL).length ? '<button type="button" class="ghost" data-act="clearrules">이 기기 기준 지우기</button>' : ''}
    </div>
    <p class="hint tiny" id="rulesMsg">유업체별 유대정산표를 양식에 옮겨 적어 불러오면 단가·배정 비율·인센티브가 한 번에 바뀝니다.</p>
    <div class="form">
      <label>납유처 ${sel('common.buyer', [...new Set([...Object.keys(RULES_LOCAL), ...Object.keys(RULES_SHARED), ...BUYERS])], c.buyer)}</label>
      <label>보유 쿼터 (L/일) ${num('common.quota', c.quota, 'step="1"')}</label>
      <label>쿼터 중 음용유 배정 (%) ${num('common.rDrink', c.rDrink, 'step="0.1"')}</label>
      <label>쿼터 중 가공유 배정 (%) ${num('common.rProc', c.rProc, 'step="0.1"')}</label>
      <label>음용유 기본가격 (원/L) ${num('common.pDrink', c.pDrink)}</label>
      <label>가공유 가격 (원/L) ${num('common.pProc', c.pProc)}</label>
      <label>쿼터 안 나머지 구간 가격 (원/L) ${num('common.pRest', c.pRest)}</label>
      <label>쿼터 초과분 가격 (원/L) ${num('common.pExcess', c.pExcess)}</label>
      <label>성분·위생 인센티브 적용 ${`<select data-path="common.incScope"><option value="quota" ${c.incScope === 'quota' ? 'selected' : ''}>쿼터 내 물량만</option><option value="all" ${c.incScope === 'all' ? 'selected' : ''}>초과유 포함 전체</option></select>`}</label>
    </div>
    <p class="hint">납유량은 쿼터 안에서 음용유 배정 → 가공유 배정 → 나머지 구간(${fmt(Math.max(0, 100 - c.rDrink - c.rProc), 1)}%) 순으로 채우고, 쿼터를 넘는 물량은 초과분 가격(일반적으로 100원/L)으로 정산합니다. 그 밖의 구간별 가격은 납유처 정산 기준으로 확인해 주세요.</p>
  </div>

  <div class="panel calc">
    <h3 class="calc-h">② 현재 vs 목표</h3>
    <table class="cmp-in"><thead><tr><th></th><th>현재</th><th>목표</th></tr></thead><tbody>
      ${rowsIn.map(([k, label, a]) => `<tr><th>${label}</th>${['cur', 'tgt'].map((w) => `<td>${k === 'bact' ? sel(`${w}.bact`, BACT, CS[w].bact) : num(`${w}.${k}`, CS[w][k], a)}</td>`).join('')}</tr>`).join('')}
    </tbody></table>
  </div>

  <div class="panel calc">
    <h3 class="calc-h">③ 결과</h3>
    <div id="calcOut"></div>
    <a class="cta" href="#contact">이 결과로 컨설팅 상담 신청 →</a>
  </div>

  <details class="panel calc"><summary>사료 급여표로 사료비 계산하기</summary>
    <p class="hint">사료별 두당 급여량(원물 kg)·단가·수분을 넣고 [반영]을 누르면 두당 사료비와 건물섭취량이 채워집니다.</p>
    <h4>현재 급여</h4>${feedTable('cur')}
    <h4>목표(제안) 급여</h4>${feedTable('tgt')}
  </details>

  <details class="panel calc"><summary>쿼터 구매 분석</summary>
    <p class="hint">쿼터를 사면 쿼터 초과분이 쿼터 안 물량으로 바뀝니다. 추가수익 = 쿼터 구매 후 유대 − 구매 전 유대 (목표 시나리오 기준, 엑셀처럼 인센티브 차이를 전체 물량에 곱하지 않음).</p>
    <div class="form">
      <label>쿼터 가격 (원/L) ${num('quota.price', CS.quota.price, 'step="1000"')}</label>
      <label>구매량 (L/일, 비우면 필요량 자동) ${num('quota.buy', CS.quota.buy, 'step="1"')}</label>
      <label>대출 금리 (%/년) ${num('quota.rate', CS.quota.rate, 'step="0.1"')}</label>
    </div>
    <div class="result" id="quotaOut"></div>
  </details>

  <details class="panel calc"><summary>첨가제 투자 시뮬레이션</summary>
    <p class="hint">현재 시나리오 기준. 늘어난 유량이 쿼터를 넘으면 초과유 가격으로 계산합니다. 기대 효과는 실증·문헌값으로 보수적으로 넣으세요.</p>
    <div class="form">
      <label>첨가제 두당 일 비용 (원) ${num('add.cost', CS.add.cost, 'step="10"')}</label>
      <label>기대 유량 증가 (L/두/일) ${num('add.gain', CS.add.gain, 'step="0.1"')}</label>
    </div>
    <div class="result" id="addOut"></div>
  </details>

  <details class="panel calc"><summary>성분·위생 인센티브 기준표 (원/L, 편집)</summary>
    <p class="hint">기본값은 예시입니다. 소속 집유주체의 최신 유대 기준표로 고쳐 쓰세요. 체세포 고등급 감액·세균 4등급은 탈지분유 가격 연동 등 기준이 달라 0으로 두었습니다.</p>
    ${incRow('fat', '유지방', '%')}
    <p class="hint tiny">유지방: 첫 칸은 '이하', 나머지는 해당 값 '이상'</p>
    ${incRow('protein', '유단백', '%')}
    <p class="hint tiny">유단백: 해당 값 '이상' (첫 칸은 기준 미만)</p>
    ${incRow('scc', '체세포', '천 미만')}
    <div class="inc-row"><b>세균수</b>${BACT.map((g) => `<label>${g}등급${num(`inc.bact.${g}`, CS.inc.bact[g], 'step="1"')}</label>`).join('')}</div>
  </details>
  <button type="button" class="ghost reset" data-act="reset">입력값 모두 기본값으로 되돌리기</button>`;
  calc();
}

function setPath(path, raw, type) {
  const keys = path.split('.'); let o = CS;
  for (let k = 0; k < keys.length - 1; k++) o = o[keys[k]] ??= {};
  const last = keys[keys.length - 1];
  o[last] = type === 'number' ? (raw === '' ? null : parseFloat(raw)) : raw;
}

function calc() {
  if (!$('#calcOut')) return;
  const A = scenario(CS.cur), B = scenario(CS.tgt);
  const won = (x) => fmt(x), man = (x) => fmt(x / 10000, 0) + '만', pct = (x) => fmt(x, 1) + '%';
  const diff = (a, b, f, good = 1) => { const d = b - a; const cls = d === 0 ? 'flat' : (d * good > 0 ? 'good' : 'bad'); return `<td class="num ${cls}">${d > 0 ? '+' : ''}${f(d)}</td>`; };
  const row = (label, a, b, f = won, good = 1, strong = false) => (a == null || b == null) ? '' :
    `<tr class="${strong ? 'strong' : ''}"><th>${label}</th><td class="num">${f(a)}</td><td class="num">${f(b)}</td>${diff(a, b, f, good)}</tr>`;
  const grp = (t) => `<tr class="grp"><th colspan="4">${t}</th></tr>`;
  $('#calcOut').innerHTML = `<div class="tbl"><table class="cmp-out"><thead><tr><th></th><th>현재</th><th>목표</th><th>차이</th></tr></thead><tbody>
    ${grp('유대 단가 (원/L)')}
    ${row('성분·위생 인센티브', A.inc.total, B.inc.total)}
    ${row('　유지방 / 유단백', A.inc.fat + A.inc.protein, B.inc.fat + B.inc.protein)}
    ${row('　체세포 / 세균', A.inc.scc + A.inc.bact, B.inc.scc + B.inc.bact)}
    ${row('음용유 L당 유대 (기본가+인센티브)', CS.common.pDrink + A.inc.total, CS.common.pDrink + B.inc.total)}
    ${row('평균 정산 유대 (전체 물량 평균)', A.avg, B.avg, (x) => fmt(x, 1), 1, true)}
    ${grp('납유량 배분 (L/일)')}
    ${row('총 납유량', A.V, B.V)}
    ${row('　음용유 배정', A.vd, B.vd)}
    ${row('　가공유 배정', A.vp, B.vp)}
    ${row('　쿼터 안 나머지 구간', A.vr, B.vr)}
    ${row('　쿼터 초과분', A.ve, B.ve, won, -1)}
    ${row('쿼터 대비 납유', A.quotaPct, B.quotaPct, pct)}
    ${grp('농장 수익 (원)')}
    ${row('일 유대수입', A.rev, B.rev)}
    ${row('일 착유우 사료비', A.feedDay, B.feedDay, won, -1)}
    ${row('일 육성·건유 사료비', A.sc.young, B.sc.young, won, -1)}
    ${row('사료비 공제 수익(IOFC) / 일', A.iofc, B.iofc, won, 1, true)}
    ${row('IOFC / 월', A.iofc * 365 / 12, B.iofc * 365 / 12, man, 1)}
    ${row('IOFC / 년', A.iofc * 365, B.iofc * 365, man, 1, true)}
    ${grp('두당·리터당')}
    ${row('두당 일 유대수입', A.perHeadRev, B.perHeadRev)}
    ${row('두당 일 IOFC (착유사료 공제)', A.perHeadIofc, B.perHeadIofc)}
    ${row('우유 L당 착유사료비', A.feedPerL, B.feedPerL, (x) => fmt(x, 1), -1)}
    ${row('유사비 (사료비 ÷ 유대수입)', A.feedRatio, B.feedRatio, pct, -1)}
    ${row('건물 kg당 사료비', A.feedPerDM, B.feedPerDM, won, -1)}
    ${row('사료효율 (L ÷ 건물 kg)', A.eff, B.eff, (x) => fmt(x, 2))}
  </tbody></table></div>
  ${B.inc.total >= A.inc.total && B.avg < A.avg ? `<p class="mix-note">ℹ 목표의 성적(인센티브 +${fmt(B.inc.total - A.inc.total)}원/L)이 더 좋은데 평균 정산 유대가 낮은 이유: 늘어난 납유량이 음용유 배정 상한(${fmt(CS.common.quota * CS.common.rDrink / 100)}L)을 넘어 <b>가공유·나머지 구간과 쿼터 초과분(${fmt(CS.common.pExcess)}원/L)</b>으로 정산되기 때문입니다. 판단은 평균 단가가 아니라 <b>유대수입과 IOFC</b>로 하세요.</p>` : ''}
  <p class="hint">목표 달성 시 연간 사료비 공제 수익 <b class="${B.iofc >= A.iofc ? 'up' : 'down'}">${B.iofc >= A.iofc ? '+' : ''}${fmt((B.iofc - A.iofc) * 365 / 10000, 0)}만 원</b>${B.ve > 0 ? ` · 목표 납유량 중 ${fmt(B.ve)}L/일이 쿼터를 넘어 ${fmt(CS.common.pExcess)}원/L로 정산됩니다 — 쿼터 구매 분석을 확인하세요.` : ''}</p>`;

  // 급여표 합계
  ['cur', 'tgt'].forEach((w) => {
    const el = $('#feedSum-' + w); if (!el) return;
    const rows = CS.feedRows[w].filter((r) => r.kg > 0);
    const cost = rows.reduce((a, r) => a + r.kg * (r.price || 0), 0), dm = rows.reduce((a, r) => a + r.kg * (100 - (r.moist || 0)) / 100, 0);
    el.innerHTML = rows.length ? `두당 사료비 <b>${fmt(cost)}원/일</b> · 원물 ${fmt(rows.reduce((a, r) => a + r.kg, 0), 1)}kg · 건물 <b>${fmt(dm, 1)}kg</b> · 건물 kg당 ${fmt(dm ? cost / dm : 0)}원` : '급여 사료를 입력하세요.';
    el.dataset.cost = cost; el.dataset.dm = dm;
  });

  // 쿼터 구매
  const q = CS.quota, c = CS.common, inc = A.inc.total;
  const need = Math.max(0, B.V - c.quota); // 목표 납유량이 모두 쿼터 안에 들도록
  const buy = q.buy > 0 ? q.buy : Math.ceil(need);
  const incB = B.inc.total, base = milkRevenue(B.V, c.quota, incB).rev, after = milkRevenue(B.V, c.quota + buy, incB).rev;
  const gainDay = after - base, gainMon = gainDay * 365 / 12, cost = buy * (q.price || 0), i = (q.rate || 0) / 100 / 12;
  let payback = '—';
  if (gainMon > 0 && cost > 0) {
    payback = i > 0 ? (gainMon > cost * i ? `${fmt(Math.log(gainMon / (gainMon - cost * i)) / Math.log(1 + i), 1)}개월 (이자 포함)` : '이자도 못 갚음 — 회수 불가') : `${fmt(cost / gainMon, 1)}개월`;
  }
  $('#quotaOut').innerHTML = `목표 납유량(${fmt(B.V)}L/일)이 모두 쿼터 안에 들려면 추가 쿼터 <b>${fmt(need, 0)} L/일</b>이 필요합니다.<br>
    구매량 <b>${fmt(buy)} L</b> × ${fmt(q.price)}원 = 구매금액 <b>${man(cost)}원</b><br>
    추가 유대수입: 일 <b>${fmt(gainDay)}원</b> · 월 <b>${man(gainMon)}원</b><br>
    회수기간: <b>${payback}</b>${cost > 0 && gainMon > 0 ? ` · 단순 ${fmt(cost / gainMon, 1)}개월` : ''}`;

  // 첨가제 (현재 기준, 쿼터 반영 한계 단가)
  const ad = CS.add, extraV = (CS.cur.heads || 0) * (ad.gain || 0);
  const addRev = milkRevenue(A.V + extraV, c.quota, inc).rev - A.rev;
  const addCost = (CS.cur.heads || 0) * (ad.cost || 0), net = addRev - addCost;
  const margPerL = extraV ? addRev / extraV : 0;
  $('#addOut').innerHTML = `늘어난 우유의 평균 단가: <b>${fmt(margPerL, 1)}원/L</b>${A.V + extraV > c.quota ? ' <span class="muted">(쿼터를 넘는 물량은 초과분 가격)</span>' : ''}<br>
    농장 일 추가수입 ${fmt(addRev)}원 − 첨가제 비용 ${fmt(addCost)}원 = 순이익 <b class="${net >= 0 ? 'up' : 'down'}">${fmt(net)}원/일</b><br>
    투자수익률(ROI): <b>${addCost ? fmt(net / addCost * 100) : 0}%</b> · 손익분기 유량 증가: <b>${margPerL ? fmt((ad.cost || 0) / margPerL, 2) : '—'} L/두/일</b><br>
    연간 순효과: <b>${man(net * 365)}원</b>`;
  saveCalc();
}

// 입력·버튼 처리 (이벤트 위임)
document.addEventListener('input', (e) => {
  const el = e.target.closest('#calcApp [data-path]'); if (!el) return;
  setPath(el.dataset.path, el.value, el.type === 'number' ? 'number' : 'text');
  calc();
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'rulesFile' && e.target.files[0]) { importRulesFile(e.target.files[0]); return; }
  const el = e.target.closest('#calcApp select[data-path]'); if (!el) return;
  if (el.dataset.path === 'common.buyer') { applyRules(el.value); return; }
  setPath(el.dataset.path, el.value, 'text'); calc();
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('#calcApp [data-act]'); if (!b) return;
  const act = b.dataset.act, who = b.dataset.who;
  if (act === 'addrow') { CS.feedRows[who].push({}); saveCalc(); renderCalc(); openDetails('사료 급여표'); }
  if (act === 'applyfeed') {
    const el = $('#feedSum-' + who); const cost = +el.dataset.cost, dm = +el.dataset.dm;
    if (cost > 0) { CS[who].feed = Math.round(cost); CS[who].dmi = Math.round(dm * 10) / 10; saveCalc(); renderCalc(); openDetails('사료 급여표'); }
  }
  if (act === 'clearrules' && confirm('이 기기에 불러온 유대 정산 기준을 지울까요? (공용 기준표는 그대로)')) {
    RULES_LOCAL = {}; try { localStorage.removeItem(RULES_LOCAL_KEY); } catch (_) { /* 무시 */ }
    applyRules(CS.common.buyer);
  }
  if (act === 'reset' && confirm('입력값을 모두 기본값으로 되돌릴까요?')) { CS = structuredClone(CALC_DEFAULTS); saveCalc(); renderCalc(); }
});
function openDetails(prefix) { document.querySelectorAll('#calcApp details').forEach((d) => { if (d.querySelector('summary').textContent.startsWith(prefix)) d.open = true; }); }
renderCalc();

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

// 새 버전 자동 반영: 서비스 워커를 매번 서버에서 확인하고, 새 버전이 화면을 넘겨받으면 한 번만 새로고침
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return; // 첫 방문(처음 설치)에는 새로고침하지 않음
    reloaded = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then((reg) => {
      reg.update();
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update(); });
    })
    .catch(() => {});
}
load().catch((err) => { $('#homeKpis').textContent = '데이터를 불러오지 못했습니다: ' + err.message; });
