# DAIRY INSIGHT · 낙농 인사이트

공식 통계 기반 낙농 시장정보 웹앱(PWA)입니다. 한우 인사이트와는 별도 저장소로 운영합니다.

## 데이터 원칙
- 공식 발표값만 사용하고 임의 보정·추정값을 만들지 않습니다.
- 미발표 월은 0이 아니라 빈칸으로 표시합니다.
- 수집에 실패하면 기존 자료를 그대로 유지하고, 앱의 '데이터 수집 상태'에 표시합니다.

## 수집 항목
| 데이터 | 출처 | 인증키 | 파일 |
|---|---|---|---|
| 젖소 암소·육우 등급판정두수, 도체중, 경락단가 (전국, 월간) | 축산물품질평가원 축산물이력제 통계 | 불필요 | `data/auto/carcass.json` |
| 원/달러 환율 (월평균) | 한국은행 ECOS | 선택 (없으면 최근 10개월만) | `data/auto/usdkrw.json` |
| 국제 곡물 월평균 가격 (옥수수·대두박·대두·밀) + 원화 환산 | 세계은행 Pink Sheet (CC BY 4.0) | 불필요 | `data/auto/grain_prices.json` |
| 조사료 수입량·수입단가 (알팔파 밀·펠릿, 건초류, 곡물 짚) | 관세청 품목별 수출입실적 | `DATA_GO_KR_KEY` | `data/auto/forage_import.json` |
| 젖소 시도/사육규모별 농장수·마릿수 | KOSIS 가축동향 DT_1EO241 | `KOSIS_API_KEY` | `data/auto/kosis_dairy_herd.json` |
| 우유 및 유제품 생산·소비 상황 | KOSIS 농식품부 DT_114N_1C001 | `KOSIS_API_KEY` | `data/auto/kosis_milk_supply.json` |
| 젖소 두당 수익성·사육비 | KOSIS 생산비조사 DT_2EE303, DT_2EE302 | `KOSIS_API_KEY` | `data/auto/kosis_dairy_*.json` |
| 원유 기본가격, 젖소 수송아지 가격 | 낙농진흥회, 농협 축산정보센터 | 직접 입력 | `data/manual.json` |

## 자동 수집
- `.github/workflows/collect.yml`이 매일 10:23(KST)에 `collector/collect.py`를 실행하고, 바뀐 데이터만 커밋합니다.
- Actions 탭 → "공식 데이터 자동 수집" → **Run workflow**로 즉시 실행할 수 있습니다.

### 인증키 등록 (무료)
1. 키를 발급받습니다.
   - KOSIS: https://kosis.kr/openapi → 활용신청
   - 공공데이터포털: https://www.data.go.kr → "관세청_품목별 수출입실적" 활용신청
   - 한국은행 ECOS: https://ecos.bok.or.kr/api → 인증키 신청
2. 저장소 **Settings → Secrets and variables → Actions → New repository secret**에 `KOSIS_API_KEY`, `DATA_GO_KR_KEY`, `ECOS_API_KEY` 이름으로 등록합니다.
3. 키는 코드나 채팅에 붙여넣지 말고 Secrets에만 넣어 주세요.

## 로컬 실행
```bash
python3 collector/collect.py
python3 -m http.server 8000
```

## 공개 (GitHub Pages)
Settings → Pages → Branch: `main` / `(root)`
