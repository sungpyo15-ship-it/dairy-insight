"""유업체별 유대 정산 기준 엑셀(templates/유대정산표_양식.xlsx 양식) → data/auto/milk_rules.json

data/upload/ 폴더의 .xlsx 파일을 모두 읽어 합친다(파일 이름순, 뒤 파일이 같은 유업체를 덮어씀).
열은 위치가 아니라 제목 글자로 찾으므로 열 순서가 바뀌어도 읽을 수 있다.
값이 이상하면(비율 합 100% 초과, 숫자 아님 등) 그 유업체는 건너뛰고 경고로 남긴다.
"""
import glob
import os
import re


def _num(v):
    if v is None or str(v).strip() == "":
        return None
    try:
        return float(str(v).replace(",", "").replace("%", "").strip())
    except ValueError:
        raise ValueError(f"숫자가 아닌 값: {v!r}")


def _rows(ws):
    """제목 줄(‘유업체’가 있는 줄)을 찾아 {제목: 값} 목록으로 돌려준다."""
    rows = list(ws.iter_rows(values_only=True))
    hi = next((i for i, r in enumerate(rows) if r and any(str(c or "").strip() == "유업체" for c in r)), None)
    if hi is None:
        raise ValueError(f"'{ws.title}' 시트에서 '유업체' 제목 줄을 찾지 못했습니다")
    head = [re.sub(r"\s+", "", str(c or "")) for c in rows[hi]]
    out = []
    for r in rows[hi + 1:]:
        if not r or not str(r[0] or "").strip():
            continue
        out.append({h: r[k] if k < len(r) else None for k, h in enumerate(head) if h})
    return out


def _col(row, *keys):
    for h, v in row.items():
        if all(k in h for k in keys):
            return v
    return None


def parse_workbook(path):
    from openpyxl import load_workbook
    wb = load_workbook(path, data_only=True, read_only=True)
    need = ["단가", "유지방", "유단백", "체세포", "세균"]
    missing = [n for n in need if n not in wb.sheetnames]
    if missing:
        raise ValueError(f"시트 없음: {', '.join(missing)} (양식의 시트 이름을 바꾸지 마세요)")
    buyers, warnings = {}, []
    for r in _rows(wb["단가"]):
        name = str(r.get("유업체")).strip()
        try:
            common = {
                "pDrink": _num(_col(r, "음용유가격")), "pProc": _num(_col(r, "가공유가격")),
                "pRest": _num(_col(r, "나머지")), "pExcess": _num(_col(r, "초과분")),
                "rDrink": _num(_col(r, "음용유배정")), "rProc": _num(_col(r, "가공유배정")),
            }
            scope = str(_col(r, "인센티브") or "쿼터내").strip()
            common["incScope"] = "all" if scope.startswith("전체") else "quota"
            if any(common[k] is None for k in ("pDrink", "pExcess", "rDrink")):
                raise ValueError("음용유 가격·쿼터 초과분 가격·음용유 배정은 꼭 입력해야 합니다")
            common["pProc"] = common["pProc"] if common["pProc"] is not None else common["pDrink"]
            common["pRest"] = common["pRest"] if common["pRest"] is not None else common["pProc"]
            common["rProc"] = common["rProc"] or 0
            if common["rDrink"] + common["rProc"] > 100:
                raise ValueError("음용유+가공유 배정이 100%를 넘습니다")
            d = _col(r, "기준일")
            buyers[name] = {"date": d.strftime("%Y-%m-%d") if hasattr(d, "strftime") else (str(d).strip() if d else ""),
                            "note": str(_col(r, "출처") or "").strip(), "common": common,
                            "inc": {"fat": [], "protein": [], "scc": [], "bact": {}}}
        except ValueError as e:
            warnings.append(f"[단가] {name}: {e}")

    def table(sheet, key, th_keys):
        for r in _rows(wb[sheet]):
            name = str(r.get("유업체")).strip()
            if name not in buyers:
                continue
            try:
                th, v = _num(_col(r, *th_keys)), _num(_col(r, "가감액"))
                if v is None:
                    continue
                buyers[name]["inc"][key].append([th, v])
            except ValueError as e:
                warnings.append(f"[{sheet}] {name}: {e}")

    table("유지방", "fat", ["기준"])
    table("유단백", "protein", ["기준"])
    table("체세포", "scc", ["기준"])
    for r in _rows(wb["세균"]):
        name = str(r.get("유업체")).strip()
        if name in buyers:
            g = str(_col(r, "등급") or "").strip().upper().replace("등급", "")
            v = _col(r, "가감액")
            if g and v is not None:
                buyers[name]["inc"]["bact"][g] = _num(v)

    for name, b in list(buyers.items()):
        inc = b["inc"]
        inc["fat"] = sorted([x for x in inc["fat"] if x[0] is not None], key=lambda x: x[0])
        inc["protein"] = sorted([x for x in inc["protein"] if x[0] is not None], key=lambda x: x[0])
        # 체세포: 기준 빈칸(= 그 이상)은 맨 뒤
        inc["scc"] = sorted(inc["scc"], key=lambda x: float("inf") if x[0] is None else x[0])
        empty = [k for k in ("fat", "protein", "scc") if not inc[k]] + (["bact"] if not inc["bact"] else [])
        if empty:
            warnings.append(f"{name}: 인센티브 표 비어 있음({', '.join(empty)}) — 앱 기존 값 유지")
    return buyers, warnings


def collect(upload_dir):
    files = sorted(glob.glob(os.path.join(upload_dir, "*.xlsx")))
    files = [f for f in files if not os.path.basename(f).startswith("~$")]
    if not files:
        return None
    buyers, warnings = {}, []
    for f in files:
        try:
            b, w = parse_workbook(f)
            buyers.update(b)
            warnings += [f"{os.path.basename(f)}: {x}" for x in w]
        except Exception as e:  # 파일 하나가 잘못돼도 나머지는 반영
            warnings.append(f"{os.path.basename(f)}: {e}")
    if not buyers:
        raise RuntimeError("읽을 수 있는 유업체 기준이 없습니다 — " + "; ".join(warnings))
    return {"id": "milk_rules", "title": "유업체별 유대 정산 기준",
            "source": "사용자 업로드 엑셀 (data/upload)", "files": [os.path.basename(f) for f in files],
            "warnings": warnings, "buyers": buyers,
            "records": [{"period": b["date"] or "-", "buyer": n} for n, b in buyers.items()]}
