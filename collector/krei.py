"""KREI 농업관측센터 '축산관측 젖소' 분기 보고서 자동 추출 (OCR)

보고서 PDF는 글자가 도형(외곽선)으로 저장돼 텍스트 추출이 안 되므로
300dpi 이미지 → 색 선 제거(어둡고 채도 낮은 글자만 남김) → Tesseract(kor) OCR 순서로 읽는다.

신뢰 원칙
  - 표는 행 합계·재고 연결 관계로 검증하고, 하나라도 맞지 않으면 그 표는 저장하지 않는다.
  - 산지가격 문장은 숫자가 깨끗하게 읽힌 항목만 저장하고, 깨진 항목은 추측하지 않고 건너뛴다.
  - 새 호의 값이 이전 호 값을 덮어쓴다(잠정치 → 확정치 반영).

필요 프로그램: pdftoppm(poppler-utils), tesseract-ocr + tesseract-ocr-kor, Pillow
"""
import os
import re
import shutil
import subprocess
import tempfile

LIST_URL = "https://www.aglook.kr/main/uObserveMonth/OVR0000000016"
BASE = "https://www.aglook.kr"
NUM = r"-?\d[\d,]*\.?\d*"


def find_latest(http_get):
    page = http_get(LIST_URL)
    m = re.search(r"/main/uObserveMonth/OVR0000000016/download/(\d+)/ORGTEXT_FILE", page)
    t = re.search(r"젖소\s*(\d{4})년\s*(\d{2})월호", page)
    if not m or not t:
        raise RuntimeError("젖소 관측 최신호 링크를 찾지 못했습니다")
    return {"issue": f"{t.group(1)}-{t.group(2)}", "title": f"축산관측 젖소 {t.group(1)}년 {t.group(2)}월호",
            "url": BASE + m.group(0)}


def tools_ready():
    missing = [t for t in ("pdftoppm", "tesseract") if not shutil.which(t)]
    if missing:
        return f"OCR 도구 없음: {', '.join(missing)}"
    langs = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True).stdout
    if "kor" not in langs.split():
        return "tesseract 한국어 데이터(kor) 없음"
    try:
        import PIL  # noqa: F401
    except ImportError:
        return "Pillow 없음"
    return None


def ocr_pages(pdf_path, workdir):
    """각 쪽을 OCR한 텍스트 목록."""
    from PIL import Image, ImageChops
    subprocess.run(["pdftoppm", "-r", "300", "-png", pdf_path, os.path.join(workdir, "p")], check=True)
    texts = []
    for name in sorted(f for f in os.listdir(workdir) if f.startswith("p-") and f.endswith(".png")):
        im = Image.open(os.path.join(workdir, name)).convert("RGB")
        r, g, b = im.split()
        mx = ImageChops.lighter(ImageChops.lighter(r, g), b)
        mn = ImageChops.darker(ImageChops.darker(r, g), b)
        dark = mx.point(lambda v: 255 if v < 120 else 0)
        gray = ImageChops.subtract(mx, mn).point(lambda v: 255 if v < 40 else 0)
        bw = ImageChops.invert(ImageChops.multiply(dark, gray))
        out = os.path.join(workdir, name.replace(".png", "-bw.png"))
        bw.save(out)
        res = subprocess.run(["tesseract", out, "-", "-l", "kor+eng", "--psm", "6"],
                             capture_output=True, text=True)
        texts.append(res.stdout)
    return texts


def nums(line):
    return [float(x.replace(",", "")) for x in re.findall(NUM, line) if re.search(r"\d", x)]


def row(text, label_re, n_vals, n_change):
    """label로 시작하는 줄에서 기간 값 n_vals개(+증감 열 n_change개)를 읽는다."""
    for ln in text.splitlines():
        if re.match(label_re, ln.strip()):
            body = re.sub(label_re, "", ln.strip(), count=1)
            v = nums(body)
            if len(v) == n_vals + n_change:
                return v[:n_vals]
    return None


def all_rows(text, label_re, n_vals, n_change):
    out = []
    for ln in text.splitlines():
        if re.match(label_re, ln.strip()):
            v = nums(re.sub(label_re, "", ln.strip(), count=1))
            if len(v) == n_vals + n_change:
                out.append(v[:n_vals])
    return out


def quarter_periods(text, n_vals):
    """표 머리의 연도 두 개(예: 2025년 2026년)로 기간 이름을 만든다: 앞 연도 4분기 + 뒤 연도 나머지."""
    years = [int(y) for y in re.findall(r"(20\d{2})\s*년", text)]
    pair = next(((a, b) for a, b in zip(years, years[1:]) if b == a + 1), None)
    if not pair or n_vals <= 4:
        return None
    y0, y1 = pair
    return [f"{y0}-Q{q}" for q in range(1, 5)] + [f"{y1}-Q{q}" for q in range(1, n_vals - 3)]


def close(a, b, tol=3):
    return abs(a - b) <= tol


def parse_supply(text):
    """원유 수급표 (원유 환산 천 톤, 분기)."""
    n = None
    for k in range(8, 4, -1):  # 기간 열 수는 5~8개로 시도
        if row(text, r"국내생산", k, 1):
            n = k
            break
    if not n:
        raise ValueError("원유 수급표를 찾지 못했습니다")
    get = lambda lab: row(text, lab, n, 1)
    carry, prod, imp = get(r"이월재고"), get(r"국내생산"), get(r"수입")
    cons, exp, stock = get(r"국내소비"), get(r"수출"), get(r"재고")
    totals = all_rows(text, r"계", n, 1)
    if not all([carry, prod, imp, cons, exp, stock]) or len(totals) < 2:
        raise ValueError("원유 수급표 행 일부를 읽지 못했습니다")
    supply_t, demand_t = totals[0], totals[1]
    for i in range(n):
        if not close(carry[i] + prod[i] + imp[i], supply_t[i]):
            raise ValueError(f"공급 합계 불일치 {i}: {carry[i]}+{prod[i]}+{imp[i]}≠{supply_t[i]}")
        if not close(cons[i] + exp[i] + stock[i], demand_t[i]):
            raise ValueError(f"수요 합계 불일치 {i}")
        if not close(supply_t[i], demand_t[i], 0):
            raise ValueError(f"공급·수요 계 불일치 {i}")
        if i + 1 < n and not close(stock[i], carry[i + 1], 1):
            raise ValueError(f"재고 연결 불일치 {i}: 재고 {stock[i]} ≠ 다음 이월 {carry[i + 1]}")
    periods = quarter_periods(text, n)
    if not periods:
        raise ValueError("원유 수급표 기간(연도)을 읽지 못했습니다")
    keys = [("carryover", carry), ("production", prod), ("import", imp), ("supply_total", supply_t),
            ("consumption", cons), ("export", exp), ("stock", stock)]
    return [{"period": p, **{k: v[i] for k, v in keys}} for i, p in enumerate(periods)]


def parse_herd(text):
    """젖소 사육 마릿수 (천 마리, 분기말 3·6·9·12월)."""
    n = None
    for k in range(8, 4, -1):
        if row(text, r"총\s*사육\s*마릿수", k, 2):
            n = k
            break
    if not n:
        raise ValueError("젖소 사육 마릿수 표를 찾지 못했습니다")
    get = lambda lab: row(text, lab, n, 2)
    total, u1, a12, o2 = get(r"총\s*사육\s*마릿수"), get(r"1세\s*미만"), get(r"1\s*[~-]\s*2세\s*미만"), get(r"2세\s*이상")
    milking, births = get(r"착유우"), get(r"생산")
    if not all([total, u1, a12, o2, milking]):
        raise ValueError("사육 마릿수 표 행 일부를 읽지 못했습니다")
    for i in range(n):
        if not close(u1[i] + a12[i] + o2[i], total[i]):
            raise ValueError(f"연령별 합계 불일치 {i}: {u1[i]}+{a12[i]}+{o2[i]}≠{total[i]}")
        if milking[i] > o2[i]:
            raise ValueError(f"착유우가 2세 이상보다 많음 {i}")
    periods = quarter_periods(text, n)
    if not periods:
        raise ValueError("사육 마릿수 표 기간(연도)을 읽지 못했습니다")
    out = []
    for i, p in enumerate(periods):
        rec = {"period": p, "total": total[i], "under1": u1[i], "age1to2": a12[i], "over2": o2[i],
               "milking": milking[i]}
        if births:
            rec["births"] = births[i]
        out.append(rec)
    return out


def issue_year_for(issue, q=None, month=None):
    """보고서는 직전 기간을 다룬다: 발간 분기 이상인 분기, 발간 월보다 늦은 월은 전년도."""
    y, m = int(issue[:4]), int(issue[5:7])
    if q is not None:
        return y - 1 if q >= (m - 1) // 3 + 1 else y
    return y - 1 if month > m else y


def first_two(text, label_re):
    """label 줄의 앞 두 숫자(전년, 금년). 줄 끝에 옆 차트 눈금이 붙어도 무시."""
    for ln in text.splitlines():
        ln = ln.strip()
        if re.match(label_re, ln) and not re.search(r"[:：]|만|천\s*톤", ln):  # 요약 문장 줄 제외, 표 행만
            v = nums(re.sub(label_re, "", ln, count=1))
            if len(v) >= 2:
                return v[:2]
    return None


def parse_feed(text, issue):
    """젖소용 배합사료 생산량 (천 톤, 분기) — 해당 분기와 전년 같은 분기."""
    m = re.search(r"(\d)분기[^\n]{0,12}배합사료\s*생산량", text)
    if not m:
        raise ValueError("배합사료 생산량 분기를 찾지 못했습니다")
    q = int(m.group(1))
    total, milk, calf, other = (first_two(text, lab) for lab in (r"전체", r"착유우용", r"송아지용", r"기타"))
    if not all([total, milk, calf, other]):
        raise ValueError("배합사료 표 행 일부를 읽지 못했습니다")
    for i in range(2):
        if not close(milk[i] + calf[i] + other[i], total[i], 2):
            raise ValueError(f"배합사료 합계 불일치: {milk[i]}+{calf[i]}+{other[i]}≠{total[i]}")
    y = issue_year_for(issue, q=q)
    return [{"period": f"{y - 1 + i}-Q{q}", "total": total[i], "milking": milk[i], "calf": calf[i],
             "other": other[i]} for i in range(2)]


def parse_slaughter(text, issue):
    """젖소 도축 마릿수 (월별) — '6월: 4,174마리(전년 대비 19.1% 증가)' 형식."""
    i = text.find("도축")
    if i < 0:
        raise ValueError("도축 동향을 찾지 못했습니다")
    seg = text[i:i + 800]
    out = []
    for m in re.finditer(r"(\d{1,2})월\s*[:：]\s*(\d{1,2},\d{3}|\d{3,5})\s*마리\s*\(전년\s*대비\s*(-?[\d.]+)%\s*(증가|감소)", seg):
        month, v = int(m.group(1)), int(m.group(2).replace(",", ""))
        if not 1 <= month <= 12 or not 1000 <= v <= 20000:  # 월 도축 1천~2만 마리 범위 밖이면 판독 오류로 봄
            continue
        pct = float(m.group(3)) * (1 if m.group(4) == "증가" else -1)
        out.append({"period": f"{issue_year_for(issue, month=month)}-{month:02d}", "head": v, "yoy_pct": pct})
    if not out:
        raise ValueError("월별 도축 마릿수 문장을 읽지 못했습니다")
    return out


PRICE_ITEMS = [("분유떼기\\s*암송아지", "calf_female", "분유떼기 암송아지"),
               ("초임만삭우", "heifer_springer", "초임만삭우"),
               ("초산우", "first_calver", "초산우"),
               ("노폐우", "cull_cow", "노폐우")]


def won(s):
    """'355만 5천 원' → 3555000. 형식이 깨끗하지 않으면 None (추측하지 않음)."""
    m = re.fullmatch(r"\s*(\d{1,4})만(?:\s*(\d)천)?\s*원\s*", s)
    if not m:
        return None
    return int(m.group(1)) * 10000 + int(m.group(2) or 0) * 1000


def parse_prices(text):
    """'2분기 OO 평균 산지가격: 22만 3천 원' 형식의 분기 평균 산지가격. 깨진 항목은 건너뜀."""
    out, skipped = [], []
    for pat, key, name in PRICE_ITEMS:
        m = re.search(r"(\d)분기\s*" + pat + r"[^:：\n]{0,12}평균\s*산지\s*가격\s*[:：]\s*([^\(\n]+)\(", text)
        if not m:
            skipped.append(name)
            continue
        v = won(m.group(2))
        if v is None:
            skipped.append(name)
            continue
        out.append({"quarter": int(m.group(1)), "item": key, "name": name, "won": v})
    return out, skipped


def collect(http_get, download, prev=None, info=None):
    """최신호(또는 info로 지정한 호)를 내려받아 추출하고, 이전 결과(prev)와 합친다."""
    problem = tools_ready()
    if problem:
        raise RuntimeError(problem)
    info = info or find_latest(http_get)
    if prev and prev.get("latest_issue_url") == info["url"] and not prev.get("warnings_retry"):
        print(f"  KREI: 최신호({info['title']}) 이미 반영됨 — OCR 생략")
        return prev
    with tempfile.TemporaryDirectory() as wd:
        pdf = os.path.join(wd, "report.pdf")
        with open(pdf, "wb") as f:
            f.write(download(info["url"]))
        pages = ocr_pages(pdf, wd)
    full = "\n".join(pages)
    results, errors = {}, []
    for name, fn in (("supply", parse_supply), ("herd", parse_herd)):
        try:
            results[name] = fn(full)
        except ValueError as e:
            errors.append(f"{name}: {e}")
    for name, fn in (("feed", parse_feed), ("slaughter", parse_slaughter)):
        try:
            results[name] = fn(full, info["issue"])
        except ValueError as e:
            errors.append(f"{name}: {e}")
    prices, skipped = parse_prices(full)
    for p in prices:
        q = p.pop("quarter")
        p["period"] = f"{issue_year_for(info['issue'], q=q)}-Q{q}"
    if not results and not prices:
        raise RuntimeError("추출 실패 — " + "; ".join(errors))

    merged = {"supply": {}, "herd": {}, "prices": {}, "feed": {}, "slaughter": {}}
    for k in merged:
        for r in (prev or {}).get(k, []):
            merged[k][(r["period"], r.get("item"))] = r
    for k in ("supply", "herd", "feed", "slaughter"):
        for r in results.get(k, []):
            merged[k][(r["period"], None)] = {**r, "issue": info["issue"]}
    for r in prices:
        merged["prices"][(r["period"], r["item"])] = {**r, "issue": info["issue"]}
    return {
        "id": "krei_dairy",
        "title": "KREI 축산관측 젖소 (원유 수급·사육·산지가격·배합사료·도축)",
        "source": "한국농촌경제연구원 농업관측센터 「축산관측 젖소」 (원유 수급표 원자료: 낙농진흥회)",
        "source_url": LIST_URL,
        "latest_issue": info["title"],
        "latest_issue_url": info["url"],
        "method": "PDF 300dpi OCR(Tesseract) · 표는 합계·재고 연결 검증 통과분만 반영",
        "warnings": errors + ([f"산지가격 판독 불가로 제외: {', '.join(skipped)}"] if skipped else []),
        "units": {"supply": "천 톤(원유 환산)", "herd": "천 마리", "prices": "원/마리",
                  "feed": "천 톤", "slaughter": "마리"},
        "feed": sorted(merged["feed"].values(), key=lambda r: r["period"]),
        "slaughter": sorted(merged["slaughter"].values(), key=lambda r: r["period"]),
        "supply": sorted(merged["supply"].values(), key=lambda r: r["period"]),
        "herd": sorted(merged["herd"].values(), key=lambda r: r["period"]),
        "prices": sorted(merged["prices"].values(), key=lambda r: (r["item"], r["period"])),
        "records": sorted(merged["supply"].values(), key=lambda r: r["period"]),  # 상태 표시용
    }
