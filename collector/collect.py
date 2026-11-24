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
import urllib.request
import xml.etree.ElementTree as ET

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


def http_get(url, opener=None, data=None, headers=None, timeout=90):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
    with (opener or urllib.request.build_opener()).open(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


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


def collect_kosis(spec):
    key = (os.environ.get("KOSIS_API_KEY") or "").strip()
    if not key:
        return None
    sid, org, tbl, prd, cnt, title = spec
    base = "https://kosis.kr/openapi/Param/statisticsParameterData.do"
    q = {"method": "getList", "apiKey": key, "itmId": "ALL", "objL1": "ALL", "objL2": "ALL",
         "objL3": "ALL", "format": "json", "jsonVD": "Y", "prdSe": prd,
         "newEstPrdCnt": str(cnt), "orgId": org, "tblId": tbl}
    d = json.loads(http_get(base + "?" + urllib.parse.urlencode(q)))
    if isinstance(d, dict):
        raise RuntimeError(f"KOSIS 오류 {d.get('err')}: {d.get('errMsg')}")
    recs = [{"period": r.get("PRD_DE"), "item": r.get("ITM_NM"), "unit": r.get("UNIT_NM"),
             "c1": r.get("C1_NM"), "c2": r.get("C2_NM"), "c3": r.get("C3_NM"),
             "value": num(r.get("DT"))} for r in d]
    if not recs:
        raise RuntimeError("수집된 행이 없습니다")
    return {"id": sid, "title": title, "source": f"KOSIS {org}/{tbl}",
            "source_url": f"https://kosis.kr/statHtml/statHtml.do?orgId={org}&tblId={tbl}",
            "period_type": prd, "records": recs}


# ---------------------------------------------------------------------------
# 4) 관세청 품목별 수출입실적 (공공데이터포털) — 조사료 수입 (인증키 필요)
# ---------------------------------------------------------------------------
FORAGE_HS = [
    ("121410", "알팔파 밀·펠릿"),
    ("121490", "건초류 (알팔파·티머시·연맥 건초 등)"),
    ("121300", "곡물 짚 (볏짚·밀짚 등)"),
]


def collect_forage():
    key = (os.environ.get("DATA_GO_KR_KEY") or "").strip()
    if not key:
        return None
    if "%" in key:  # Encoding 키를 넣은 경우 Decoding 키로 되돌림 (아래에서 한 번만 인코딩)
        key = urllib.parse.unquote(key)
    months = recent_months(36)
    recs = []
    # API는 조회기간 1년 이내 제한 → 12개월 단위로 나눠 요청
    for i in range(0, len(months), 12):
        chunk = months[i:i + 12]
        for hs, name in FORAGE_HS:
            url = ("https://apis.data.go.kr/1220000/Itemtrade/getItemtradeList?"
                   + urllib.parse.urlencode({"serviceKey": key, "strtYymm": chunk[-1],
                                             "endYymm": chunk[0], "hsSgn": hs}))
            root = ET.fromstring(http_get(url))
            code = root.findtext(".//resultCode")
            if code not in (None, "00"):
                raise RuntimeError(f"관세청 API 오류 {code}: {root.findtext('.//resultMsg')}")
            for it in root.iter("item"):
                ym = re.sub(r"\D", "", it.findtext("year") or "")
                if len(ym) != 6:
                    continue  # '총계' 행 제외
                wgt, usd = num(it.findtext("impWgt")), num(it.findtext("impDlr"))
                recs.append({"month": f"{ym[:4]}-{ym[4:]}", "hs": hs, "name": name,
                             "import_ton": round(wgt / 1000, 1) if wgt else None,
                             "import_kusd": round(usd / 1000, 1) if usd else None,
                             "usd_per_ton": round(usd / (wgt / 1000), 1) if wgt and usd else None})
    if not recs:
        raise RuntimeError("수집된 행이 없습니다")
    return {"id": "forage_import", "title": "조사료 수입량·수입단가 (관세청)",
            "source": "관세청 품목별 수출입실적 (공공데이터포털)",
            "source_url": "https://www.data.go.kr/data/15100475/openapi.do",
            "records": sorted(recs, key=lambda x: (x["hs"], x["month"]))}


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
            ("forage_import", "조사료 수입", collect_forage)]
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
                entry["message"] = "인증키 미설정 — 건너뜀"
            else:
                save(res)
                entry.update(state="ok", message=f"{len(res['records'])}행 수집",
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
