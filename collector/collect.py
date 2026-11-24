#!/usr/bin/env python3
"""DAIRY INSIGHT 공식 데이터 수집기 (표준 라이브러리만 사용)

출처별 수집 결과를 data/auto/<id>.json 에 저장하고, 실행 상태를 data/status.json 에 기록한다.
원칙
  - 공식 발표값만 저장하고 임의 보정·추정값을 만들지 않는다.
  - 수집이 실패하거나 결과가 비면 기존 파일을 그대로 보존한다.
  - 인증키가 필요한 출처는 환경변수(GitHub Secrets)가 없으면 건너뛰고 상태에 '키 없음'으로 남긴다.

환경변수
  KOSIS_API_KEY   국가통계포털 OpenAPI 인증키 (https://kosis.kr/openapi)
  ECOS_API_KEY    한국은행 ECOS 인증키 (없으면 체험용 'sample' 키로 최근 10개월만)
  DATA_GO_KR_KEY  공공데이터포털 인증키 — 관세청 품목별 수출입실적 (조사료 수입)
세계은행 원자재 가격(Pink Sheet)은 인증키 없이 수집한다.
"""
import datetime as dt
import html
import http.cookiejar
import json
import os
import re
import sys
import traceback
import urllib.parse
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import io
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUTO = os.path.join(ROOT, "data", "auto")
STATUS = os.path.join(ROOT, "data", "status.json")
KST = dt.timezone(dt.timedelta(hours=9))
UA = "Mozilla/5.0 (compatible; DairyInsightCollector/1.0)"
MONTHS_BACK = 60


def now_kst():
    return dt.datetime.now(KST).strftime("%Y-%m-%d %H:%M KST")


def recent_months(n, end=None):
    """end(기본: 지난달)부터 거꾸로 n개월 YYYYMM 목록."""
    today = dt.date.today()
    y, m = (end // 100, end % 100) if end else (today.year, today.month - 1)
    if m == 0:
        y, m = y - 1, 12
    out = []
    for _ in range(n):
        out.append(f"{y}{m:02d}")
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return out


def num(s):
    if s is None:
        return None
    s = str(s).replace(",", "").strip()
    if s in ("", "-", "x", "X", "…", "..."):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def http_get(url, opener=None, data=None, headers=None, timeout=90, tries=3):
    """일시적 연결 끊김에 대비해 최대 3회 시도 (5초, 15초 간격)."""
    import time
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
            with (opener or urllib.request.build_opener()).open(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
            if isinstance(e, urllib.error.HTTPError) and e.code < 500:
                raise  # 4xx(인증 오류 등)는 재시도해도 소용없음
            if attempt == tries - 1:
                raise
            print(f"  재시도 {attempt + 1}/{tries - 1}: {e}")
            time.sleep(5 if attempt == 0 else 15)


# ---------------------------------------------------------------------------
# 1) 축산물이력제 통계 — 소도체 등급판정 항목별 평균 (인증키 불필요)
# ---------------------------------------------------------------------------
MTRACE_TBL = "DT_323903_E1080008"
MTRACE_URL = f"https://mtrace.go.kr/statHtml/statHtml.do?orgId=323&tblId={MTRACE_TBL}&conn_path=I2"
MTRACE_ITEMS = ["count", "live", "weight", "fat", "rea", "yield_index", "marbling", "price"]
BREED = {"02": "젖소", "03": "육우"}
SEX = {"00": "전체", "01": "암", "02": "수", "03": "거세"}


def parse_grid(table_html):
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", table_html, re.S)
    cell = lambda r: [html.unescape(re.sub("<[^>]+>", "", c)).strip()
                      for c in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", r, re.S)]
    return [cell(r) for r in rows]


def collect_mtrace():
    params = json.load(open(os.path.join(ROOT, "collector", "mtrace_params.json"), encoding="utf-8"))
    months = recent_months(MONTHS_BACK)
    # 이번 달 발표분이 있을 수 있으므로 이번 달도 포함해 요청 (없으면 '-'로 돌아옴)
    t = dt.date.today()
    months = [f"{t.year}{t.month:02d}"] + months
    fl = [{"targetId": "PRD", "targetValue": "", "prdValue": "M," + ",".join(months) + ",@"}]
    fl += [{"targetId": "ITM_ID", "targetValue": f"T00{i}", "prdValue": ""} for i in range(1, 9)]
    fl += [{"targetId": "OV_L1_ID", "targetValue": v, "prdValue": ""} for v in BREED]
    fl += [{"targetId": "OV_L2_ID", "targetValue": v, "prdValue": ""} for v in SEX]
    fl += [{"targetId": "OV_L3_ID", "targetValue": "00", "prdValue": ""}]  # 체중 전체
    fl += [{"targetId": "OV_L4_ID", "targetValue": "00", "prdValue": ""}]  # 전국
    params["fieldList"] = json.dumps(fl, ensure_ascii=False)
    params["reqCellCnt"] = str(len(months) * 8 * len(BREED) * len(SEX))

    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    http_get(MTRACE_URL, op)
    body = urllib.parse.urlencode(params).encode()
    raw = http_get("https://mtrace.go.kr/statHtml/html.do", op, data=body, headers={
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest", "Referer": MTRACE_URL}, timeout=180)
    d = json.loads(raw)
    if not d.get("result"):
        raise RuntimeError(f"응답 오류: {d.get('errMsg')}")
    grid = parse_grid(d["result"][0])
    head = grid[0]
    month_cols = [re.sub(r"\D", "", h) for h in head[3:]]  # '2026. 10' -> '202610'
    item_head = grid[2]
    if not item_head[0].startswith("두수") or not item_head[7].startswith("경락단가"):
        raise RuntimeError(f"표 항목 구성이 바뀌었습니다: {item_head[:8]}")

    records, breed, sex = [], None, None
    for r in grid[3:]:
        if len(r) < 4 or not any(r[3:]):
            continue
        breed = r[0] or breed
        sex = r[1] or sex
        if r[2] != "전체" or breed not in BREED.values():
            continue
        vals = r[3:]
        for mi, m in enumerate(month_cols):
            chunk = vals[mi * 8:(mi + 1) * 8]
            rec = {k: num(v) for k, v in zip(MTRACE_ITEMS, chunk)}
            if rec["count"] is None:
                continue  # 미발표 월 — 0으로 채우지 않음
            records.append({"month": f"{m[:4]}-{m[4:]}", "breed": breed, "sex": sex, **rec})
    if not records:
        raise RuntimeError("수집된 행이 없습니다")
    records.sort(key=lambda x: (x["breed"], x["sex"], x["month"]))
    return {
        "id": "carcass",
        "title": "젖소·육우 도체 등급판정 성적 (전국)",
        "source": "축산물품질평가원 축산물이력제 통계 · 소도체 등급판정 항목별 평균",
        "source_url": MTRACE_URL,
        "units": {"count": "두", "live": "kg", "weight": "kg", "fat": "mm", "rea": "㎠",
                  "yield_index": "", "marbling": "No.", "price": "원/kg"},
        "records": records,
    }


# ---------------------------------------------------------------------------
# 2) 한국은행 ECOS — 원/달러 환율 (월평균)
# ---------------------------------------------------------------------------
def collect_ecos():
    key = (os.environ.get("ECOS_API_KEY") or "").strip() or "sample"
    months = recent_months(MONTHS_BACK)
    start, end = months[-1], months[0]
    n = 10 if key == "sample" else MONTHS_BACK + 2
    if key == "sample":
        start = months[9]
    url = (f"https://ecos.bok.or.kr/api/StatisticSearch/{key}/json/kr/1/{n}/"
           f"731Y004/M/{start}/{end}/0000001/0000100")
    d = json.loads(http_get(url))
    rows = d.get("StatisticSearch", {}).get("row") or []
    if not rows:
        raise RuntimeError(f"응답 없음: {json.dumps(d, ensure_ascii=False)[:200]}")
    recs = [{"month": f"{r['TIME'][:4]}-{r['TIME'][4:]}", "value": num(r["DATA_VALUE"])} for r in rows]
    return {
        "id": "usdkrw",
        "title": "원/달러 환율 (월평균, 매매기준율)",
        "source": "한국은행 경제통계시스템(ECOS) 731Y004",
        "source_url": "https://ecos.bok.or.kr",
        "unit": "원",
        "note": "체험용 키로 최근 10개월만 수집" if key == "sample" else "",
        "records": sorted(recs, key=lambda x: x["month"]),
    }


# ---------------------------------------------------------------------------
# 3) KOSIS OpenAPI — 젖소 사육, 우유 생산·소비, 생산비 (인증키 필요)
#    표의 분류 구성은 키 발급 후 첫 수집에서 원자료(raw)로 확인하고 지표를 확정한다.
# ---------------------------------------------------------------------------
KOSIS_TABLES = [
    # id, orgId, tblId, 주기, 최근 기간 수, 설명
    ("kosis_dairy_herd", "101", "DT_1EO241", "Q", 20, "젖소 시도/사육규모별 농장수 및 마릿수 (가축동향, 이력제 자료)"),
    ("kosis_milk_supply", "114", "DT_114N_1C001", "Y", 10, "우유 및 유제품 생산·소비 상황 (농림축산식품부)"),
    ("kosis_dairy_profit", "101", "DT_2EE303", "Y", 8, "젖소 두당 수익성 (농축산물생산비조사)"),
    ("kosis_dairy_cost", "101", "DT_2EE302", "Y", 8, "젖소 두당 사육비 (농축산물생산비조사)"),
]


def _kosis_call(url, params):
    d = json.loads(http_get(url + "?" + urllib.parse.urlencode(params)))
    if isinstance(d, dict) and d.get("err"):
        raise KosisError(d.get("err"), d.get("errMsg"))
    return d


class KosisError(RuntimeError):
    def __init__(self, code, msg):
        super().__init__(f"KOSIS 오류 {code}: {msg}")
        self.code = str(code)


def _kosis_shape(key, org, tbl):
    """메타 API로 분류 단계 수(objL1~n)와 수록주기 목록을 확인한다. 실패하면 (None, [])."""
    meta = "https://kosis.kr/openapi/statisticsData.do"
    base = {"method": "getMeta", "apiKey": key, "format": "json", "jsonVD": "Y", "orgId": org, "tblId": tbl}
    levels, periods = None, []
    try:
        itm = _kosis_call(meta, {**base, "type": "ITM"})
        objs = {r.get("OBJ_ID") for r in itm if r.get("OBJ_ID") and r.get("OBJ_ID") != "ITEM"
                and r.get("OBJ_NM") != "항목"}
        levels = len(objs) or None
    except Exception as e:
        print(f"  KOSIS 메타(ITM) 조회 실패 {tbl}: {e}")
    try:
        prd = _kosis_call(meta, {**base, "type": "PRD"})
        periods = [r.get("PRD_SE") for r in prd if r.get("PRD_SE")]
    except Exception as e:
        print(f"  KOSIS 메타(PRD) 조회 실패 {tbl}: {e}")
    return levels, periods


PRD_CODE = {"월": "M", "분기": "Q", "반기": "H", "년": "Y", "연": "Y"}


def collect_kosis(spec):
    key = (os.environ.get("KOSIS_API_KEY") or "").strip()
    if not key:
        return None
    sid, org, tbl, prd, cnt, title = spec
    url = "https://kosis.kr/openapi/Param/statisticsParameterData.do"
    levels, periods = _kosis_shape(key, org, tbl)
    prd_codes = [PRD_CODE.get(p, p) for p in periods]
    # 시도 순서: (메타가 알려준 단계 수, 주기) → 실패 시 단계 1~4 × 주기 후보를 차례로
    prd_try = [p for p in [prd] + prd_codes + ["M", "Q", "Y"] if p in ("M", "Q", "H", "Y")]
    prd_try = list(dict.fromkeys(prd_try))
    lvl_try = list(dict.fromkeys(([levels] if levels else []) + [1, 2, 3, 4]))
    last_err = None
    for p in prd_try:
        for n in lvl_try:
            q = {"method": "getList", "apiKey": key, "itmId": "ALL", "format": "json", "jsonVD": "Y",
                 "prdSe": p, "newEstPrdCnt": str(cnt), "orgId": org, "tblId": tbl}
            q.update({f"objL{k}": "ALL" for k in range(1, n + 1)})
            try:
                d = _kosis_call(url, q)
            except KosisError as e:
                last_err = e
                if e.code in ("10", "11"):  # 인증키 문제 — 더 시도해도 같음
                    raise
                if e.code == "31" and int(q["newEstPrdCnt"]) > 2:  # 조회 셀 수 초과 → 기간 축소
                    q["newEstPrdCnt"] = str(max(2, cnt // 3))
                    try:
                        d = _kosis_call(url, q)
                    except KosisError as e2:
                        last_err = e2
                        continue
                else:
                    continue
            recs = [{"period": r.get("PRD_DE"), "item": r.get("ITM_NM"), "unit": r.get("UNIT_NM"),
                     "c1": r.get("C1_NM"), "c2": r.get("C2_NM"), "c3": r.get("C3_NM"),
                     "c4": r.get("C4_NM"), "value": num(r.get("DT"))} for r in d]
            if recs:
                print(f"  KOSIS {tbl}: 주기 {p}, 분류 {n}단계로 수집")
                return {"id": sid, "title": title, "source": f"KOSIS {org}/{tbl}",
                        "source_url": f"https://kosis.kr/statHtml/statHtml.do?orgId={org}&tblId={tbl}",
                        "period_type": p, "levels": n, "records": recs}
    raise RuntimeError(f"모든 조회 조건 실패 (메타: 분류 {levels}단계, 주기 {prd_codes}) — 마지막 {last_err}")


# ---------------------------------------------------------------------------
# 4) 관세청 품목별 수출입실적 (공공데이터포털) — 조사료·유제품 수입 (인증키 필요)
#    HS 6자리로 조회하고, 응답이 10자리 세부품목으로 나뉘어 오면 월별로 합산한다.
#    관세청이 돌려준 품목명(hs_names)을 함께 저장해 코드가 의도한 품목인지 검증한다.
# ---------------------------------------------------------------------------
CUSTOMS_URL = "https://apis.data.go.kr/1220000/Itemtrade/getItemtradeList"
CUSTOMS_SETS = {
    "forage_import": {
        "title": "조사료 수입량·수입단가 (관세청)",
        "items": [
            ("121410", "알팔파 밀·펠릿", "조사료"),
            ("121490", "건초류 (알팔파·티머시·연맥 건초 등)", "조사료"),
            ("121300", "곡물 짚 (볏짚·밀짚 등)", "조사료"),
        ],
    },
    "dairy_import": {
        "title": "유제품 수입량·수입단가 (관세청)",
        "items": [
            ("040110", "우유 (지방 1% 이하)", "우유·멸균유"),
            ("040120", "우유 (지방 1~6%, 멸균유 대부분)", "우유·멸균유"),
            ("040210", "탈지분유 (지방 1.5% 이하)", "분유"),
            ("040221", "전지분유 (무가당)", "분유"),
            ("040229", "가당 분유", "분유"),
            ("190110", "조제분유 (영유아용 조제식료품)", "분유"),
            ("040410", "유장·유장분말 (대용유 원료)", "유청·대용유 원료"),
            ("040510", "버터", "버터·치즈"),
            ("040610", "신선치즈 (모차렐라 등)", "버터·치즈"),
            ("040690", "기타 치즈 (체다·고다 등)", "버터·치즈"),
        ],
    },
}


def _customs_key():
    key = (os.environ.get("DATA_GO_KR_KEY") or "").strip()
    if "%" in key:  # Encoding 키를 넣은 경우 Decoding 키로 되돌림 (아래에서 한 번만 인코딩)
        key = urllib.parse.unquote(key)
    return key


MIN_TON_FOR_PRICE = 1.0  # 1톤 미만 소량 거래는 단가가 왜곡되므로 단가를 계산하지 않음


def unit_price(wgt_kg, usd):
    return round(usd / (wgt_kg / 1000), 1) if wgt_kg and usd and wgt_kg / 1000 >= MIN_TON_FOR_PRICE else None


def collect_customs(set_id):
    key = _customs_key()
    if not key:
        return None
    spec = CUSTOMS_SETS[set_id]
    months = recent_months(36)
    agg, names, sub_names = {}, {}, {}
    # API는 조회기간 1년 이내 제한 → 12개월 단위로 나눠 요청
    for i in range(0, len(months), 12):
        chunk = months[i:i + 12]
        for hs, name, cat in spec["items"]:
            url = CUSTOMS_URL + "?" + urllib.parse.urlencode(
                {"serviceKey": key, "strtYymm": chunk[-1], "endYymm": chunk[0], "hsSgn": hs})
            root = ET.fromstring(http_get(url))
            code = root.findtext(".//resultCode")
            if code not in (None, "00"):
                raise RuntimeError(f"관세청 API 오류 {code}: {root.findtext('.//resultMsg')}")
            for it in root.iter("item"):
                ym = re.sub(r"\D", "", it.findtext("year") or "")
                if len(ym) != 6:
                    continue  # '총계' 행 제외
                kor = (it.findtext("statKor") or "").strip()
                if kor:
                    names.setdefault(hs, set()).add(kor)
                # 세부품목(10자리) 단위로 덮어써서 같은 달이 중복 응답돼도 두 번 더하지 않음
                sub = (it.findtext("hsCd") or kor or hs).strip()
                sub_names[sub] = kor or sub_names.get(sub, "")
                agg[(hs, ym, sub)] = (num(it.findtext("impWgt")) or 0, num(it.findtext("impDlr")) or 0)
    totals = {}
    for (hs, ym, sub), (w, u) in agg.items():
        t = totals.setdefault((hs, ym), {"wgt": 0.0, "usd": 0.0, "subs": []})
        t["wgt"] += w
        t["usd"] += u
        t["subs"].append({"code": sub, "name": sub_names.get(sub, ""), "import_ton": round(w / 1000, 1),
                          "usd_per_ton": unit_price(w, u)})
    meta = {hs: (name, cat) for hs, name, cat in spec["items"]}
    recs = []
    for (hs, ym), t in totals.items():
        recs.append({"month": f"{ym[:4]}-{ym[4:]}", "hs": hs, "name": meta[hs][0], "category": meta[hs][1],
                     "import_ton": round(t["wgt"] / 1000, 1),
                     "import_kusd": round(t["usd"] / 1000, 1),
                     "usd_per_ton": unit_price(t["wgt"], t["usd"]),
                     "subs": sorted(t["subs"], key=lambda x: x["code"])})
    if not recs:
        raise RuntimeError("수집된 행이 없습니다")
    return {"id": set_id, "title": spec["title"],
            "source": "관세청 품목별 수출입실적 (공공데이터포털)",
            "source_url": "https://www.data.go.kr/data/15100475/openapi.do",
            "hs_names": {k: sorted(v) for k, v in names.items()},
            "records": sorted(recs, key=lambda x: (x["hs"], x["month"]))}


# ---------------------------------------------------------------------------
# 5) 세계은행 원자재 가격 (Pink Sheet) — 국제 곡물 월평균 가격 (인증키 불필요)
#    라이선스: CC BY 4.0 — 출처 "World Bank Commodity Price Data (The Pink Sheet)" 표기
# ---------------------------------------------------------------------------
WB_PAGE = "https://www.worldbank.org/en/research/commodity-markets"
# (파일의 열 이름, 앱 표시 이름) — 열 위치가 아니라 이름으로 찾는다
WB_ITEMS = [
    ("Maize", "옥수수"),
    ("Soybean meal", "대두박"),
    ("Soybeans", "대두"),
    ("Wheat, US HRW", "밀 (미국 HRW)"),
]
XNS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def read_xlsx_sheet(data, sheet_name):
    """표준 라이브러리로 xlsx 한 시트를 [{열문자: 값}] 목록으로 읽는다."""
    z = zipfile.ZipFile(io.BytesIO(data))
    wb = z.read("xl/workbook.xml").decode()
    rid = re.search(r'<sheet [^>]*name="%s"[^>]*r:id="([^"]+)"' % re.escape(sheet_name), wb)
    if not rid:
        raise RuntimeError(f"시트 '{sheet_name}'를 찾지 못했습니다")
    rels = z.read("xl/_rels/workbook.xml.rels").decode()
    target = re.search(r'Id="%s"[^>]*Target="([^"]+)"' % rid.group(1), rels) or \
        re.search(r'Target="([^"]+)"[^>]*Id="%s"' % rid.group(1), rels)
    path = "xl/" + target.group(1).lstrip("/").replace("xl/", "")
    ss = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(XNS + "si"):
            ss.append("".join(t.text or "" for t in si.iter(XNS + "t")))
    rows = []
    for r in ET.fromstring(z.read(path)).iter(XNS + "row"):
        row = {}
        for c in r.iter(XNS + "c"):
            col, t, v = re.sub(r"\d", "", c.get("r")), c.get("t"), c.find(XNS + "v")
            if t == "inlineStr":
                row[col] = "".join(x.text or "" for x in c.iter(XNS + "t"))
            elif v is not None:
                row[col] = ss[int(v.text)] if t == "s" else v.text
        rows.append(row)
    return rows


def collect_worldbank():
    page = http_get(WB_PAGE)
    m = re.search(r'https?://[^"\' ]*CMO-Historical-Data-Monthly\.xlsx', page)
    if not m:
        raise RuntimeError("월간 자료 파일 링크를 찾지 못했습니다")
    url = m.group(0)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=180) as r:
        data = r.read()
    rows = read_xlsx_sheet(data, "Monthly Prices")
    updated = next((v for r in rows[:6] for v in r.values() if str(v).startswith("Updated")), "")
    hdr_i = next(i for i, r in enumerate(rows[:15]) if "Maize" in r.values())
    hdr, unit_row = rows[hdr_i], rows[hdr_i + 1]
    cols = {}
    for name, ko in WB_ITEMS:
        col = next((k for k, v in hdr.items() if v.strip() == name), None)
        if not col:
            raise RuntimeError(f"'{name}' 열을 찾지 못했습니다 — 파일 구성 변경 확인 필요")
        if "$/mt" not in unit_row.get(col, ""):
            raise RuntimeError(f"'{name}' 단위가 바뀌었습니다: {unit_row.get(col)}")
        cols[name] = (col, ko)
    cutoff = recent_months(MONTHS_BACK + 1)[-1]
    recs = []
    for r in rows[hdr_i + 2:]:
        pm = re.fullmatch(r"(\d{4})M(\d{2})", str(r.get("A", "")).strip())
        if not pm or pm.group(1) + pm.group(2) < cutoff:
            continue
        for name, (col, ko) in cols.items():
            val = num(r.get(col))
            if val is not None:
                recs.append({"month": f"{pm.group(1)}-{pm.group(2)}", "item": name, "name": ko,
                             "usd_per_ton": round(val, 2)})
    if not recs:
        raise RuntimeError("수집된 행이 없습니다")
    return {"id": "grain_prices", "title": "국제 곡물 가격 (월평균, USD/톤)",
            "source": "World Bank Commodity Price Data (The Pink Sheet), CC BY 4.0",
            "source_url": WB_PAGE, "file_url": url, "published": updated,
            "records": sorted(recs, key=lambda x: (x["item"], x["month"]))}


# ---------------------------------------------------------------------------
# 6) 미국 건초 생산자물가지수 (BLS PPI, FRED 경유) — 인증키 불필요
#    가격(달러)이 아니라 지수(1982=100)다. 미국 현지 건초 가격 흐름을 보는 용도.
# ---------------------------------------------------------------------------
FRED_SERIES = [
    ("WPU01810101", "미국 알팔파 건초 생산자물가지수"),
    ("WPU01810102", "미국 기타 건초 생산자물가지수"),
]


def curl_get(url, tries=3):
    """FRED는 Python 기본 HTTP 클라이언트와 브라우저 흉내 UA의 연결을 끊어서 기본 curl로 내려받는다."""
    import subprocess
    import time
    for attempt in range(tries):
        r = subprocess.run(["curl", "-sS", "-f", "-L", "-m", "60", url],  # 기본 curl UA 사용 (브라우저 흉내 UA는 FRED가 차단)
                           capture_output=True, text=True)
        if r.returncode == 0 and r.stdout:
            return r.stdout
        if attempt == tries - 1:
            raise RuntimeError(f"curl 실패({r.returncode}): {r.stderr.strip()[:200]}")
        print(f"  재시도 {attempt + 1}/{tries - 1}: curl {r.returncode}")
        time.sleep(5 if attempt == 0 else 15)


def collect_fred_hay():
    cutoff = recent_months(MONTHS_BACK + 1)[-1]
    recs = []
    for sid, name in FRED_SERIES:
        text = curl_get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}")
        lines = text.strip().splitlines()
        if not lines or sid not in lines[0]:
            raise RuntimeError(f"{sid} 응답 형식이 바뀌었습니다: {lines[0][:80] if lines else ''}")
        for ln in lines[1:]:
            date, _, val = ln.partition(",")
            ym = date[:7].replace("-", "")
            v = num(val)
            if v is None or ym < cutoff:
                continue
            recs.append({"month": date[:7], "series": sid, "name": name, "value": v})
    if not recs:
        raise RuntimeError("수집된 행이 없습니다")
    return {"id": "us_hay_ppi", "title": "미국 건초 생산자물가지수 (1982=100)",
            "source": "U.S. Bureau of Labor Statistics PPI, FRED(세인트루이스 연준) 제공",
            "source_url": "https://fred.stlouisfed.org/series/WPU01810101", "unit": "지수(1982=100)",
            "records": sorted(recs, key=lambda x: (x["series"], x["month"]))}


# ---------------------------------------------------------------------------
# 7) KREI 축산관측 젖소 (분기) — 원유 수급표·사육 마릿수·산지가격 OCR 추출 (인증키 불필요)
# ---------------------------------------------------------------------------
def download_bytes(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read()


def collect_krei():
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import krei
    try:
        prev = json.load(open(os.path.join(AUTO, "krei_dairy.json"), encoding="utf-8"))
    except Exception:
        prev = None
    return krei.collect(http_get, download_bytes, prev)


# ---------------------------------------------------------------------------
# 8) 유업체별 유대 정산 기준 — data/upload/*.xlsx (사용자 업로드) → data/auto/milk_rules.json
# ---------------------------------------------------------------------------
def collect_milk_rules():
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import milk_rules
    res = milk_rules.collect(os.path.join(ROOT, "data", "upload"))
    if res is None:
        return None
    for w in res["warnings"]:
        print("  경고:", w)
    return res


# ---------------------------------------------------------------------------
def save(result):
    os.makedirs(AUTO, exist_ok=True)
    result["collected_at"] = now_kst()
    path = os.path.join(AUTO, result["id"] + ".json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    return path


def latest_period(result):
    ps = [r.get("month") or r.get("period") for r in result.get("records", [])]
    ps = [p for p in ps if p]
    return max(ps) if ps else None


def main():
    jobs = [("carcass", "젖소·육우 도체 성적·경락가", collect_mtrace),
            ("usdkrw", "원/달러 환율", collect_ecos),
            ("grain_prices", "국제 곡물 가격 (세계은행)", collect_worldbank),
            ("us_hay_ppi", "미국 건초 생산자물가지수 (FRED)", collect_fred_hay),
            ("krei_dairy", "KREI 축산관측 젖소 (원유 수급·사육·산지가격)", collect_krei),
            ("milk_rules", "유업체별 유대 정산 기준 (업로드 엑셀)", collect_milk_rules),
            ("forage_import", "조사료 수입", lambda: collect_customs("forage_import")),
            ("dairy_import", "유제품 수입 (우유·멸균유·분유·유청·버터·치즈)", lambda: collect_customs("dairy_import"))]
    jobs += [(s[0], s[5], (lambda s=s: collect_kosis(s))) for s in KOSIS_TABLES]

    try:
        status = json.load(open(STATUS, encoding="utf-8"))
    except Exception:
        status = {"datasets": {}}
    status["checked_at"] = now_kst()
    failed = 0
    for sid, label, fn in jobs:
        prev = status["datasets"].get(sid, {})
        entry = {"label": label, "last_success": prev.get("last_success"),
                 "latest_period": prev.get("latest_period")}
        try:
            res = fn()
            if res is None:
                entry["state"] = "no_key"
                entry["message"] = "업로드 파일 없음 — 건너뜀" if sid == "milk_rules" else "인증키 미설정 — 건너뜀"
            else:
                save(res)
                msg = f"{len(res['records'])}행 수집"
                if res.get("warnings"):
                    msg += " · 경고: " + " / ".join(res["warnings"])[:250]
                entry.update(state="ok", message=msg,
                             last_success=now_kst(), latest_period=latest_period(res))
        except Exception as e:  # 실패 시 기존 파일 보존
            failed += 1
            entry["state"] = "error"
            entry["message"] = f"{type(e).__name__}: {e}"[:300]
            traceback.print_exc()
        status["datasets"][sid] = entry
        print(f"[{entry['state']}] {label}: {entry['message']}")

    with open(STATUS, "w", encoding="utf-8") as f:
        json.dump(status, f, ensure_ascii=False, indent=1)
    return 1 if failed == len(jobs) else 0


if __name__ == "__main__":
    sys.exit(main())
