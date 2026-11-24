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
| 미국 알팔파·기타 건초 생산자물가지수 (1982=100) | 미국 노동통계국 PPI (FRED 경유) | 불필요 | `data/auto/us_hay_ppi.json` |
| 조사료 수입량·수입단가·원화 수입원가 (알팔파 밀·펠릿, 건초류, 곡물 짚, 세부품목별) | 관세청 품목별 수출입실적 | `DATA_GO_KR_KEY` | `data/auto/forage_import.json` |
| 유제품 수입량·수입단가 (우유·멸균유, 탈지·전지·가당·조제분유, 유장, 버터, 치즈) | 관세청 품목별 수출입실적 | `DATA_GO_KR_KEY` | `data/auto/dairy_import.json` |
| 젖소 시도/사육규모별 농장수·마릿수 | KOSIS 가축동향 DT_1EO241 | `KOSIS_API_KEY` | `data/auto/kosis_dairy_herd.json` |
| 우유 및 유제품 생산·소비 상황 | KOSIS 농식품부 DT_114N_1C001 | `KOSIS_API_KEY` | `data/auto/kosis_milk_supply.json` |
| 젖소 두당 수익성·사육비 | KOSIS 생산비조사 DT_2EE303, DT_2EE302 | `KOSIS_API_KEY` | `data/auto/kosis_dairy_*.json` |
| 원유 수급표(국내생산·수입·소비·재고, 분기), 젖소 사육 마릿수(연령별·착유우·송아지 생산), 젖소 산지가격, 젖소용 배합사료 생산량(분기), 젖소 도축 마릿수(월) | KREI 「축산관측 젖소」 분기 보고서 PDF를 OCR로 판독 (수급표 원자료: 낙농진흥회) | 불필요 | `data/auto/krei_dairy.json` |
| 원유 기본가격, 젖소 수송아지 가격 | 낙농진흥회, 농협 축산정보센터 | 직접 입력 | `data/manual.json` |

## 자동 수집
- KREI 보고서는 글자가 그림으로 저장돼 있어 OCR(Tesseract)로 읽습니다. 표는 합계·재고 연결 관계 검증을 통과한 값만 반영하고, 산지가격 문장은 숫자가 깨끗하게 읽힌 항목만 반영합니다. 새 호가 나왔을 때만 OCR을 실행합니다.
- `.github/workflows/collect.yml`이 매일 10:23(KST)에 `collector/collect.py`를 실행하고, 바뀐 데이터만 커밋합니다.
- Actions 탭 → "공식 데이터 자동 수집" → **Run workflow**로 즉시 실행할 수 있습니다.

### 인증키 등록 (무료)
1. 키를 발급받습니다.
   - KOSIS: https://kosis.kr/openapi → 활용신청
   - 공공데이터포털: https://www.data.go.kr → "관세청_품목별 수출입실적" 활용신청
   - 한국은행 ECOS: https://ecos.bok.or.kr/api → 인증키 신청
2. 저장소 **Settings → Secrets and variables → Actions → New repository secret**에 `KOSIS_API_KEY`, `DATA_GO_KR_KEY`, `ECOS_API_KEY` 이름으로 등록합니다.
3. 키는 코드나 채팅에 붙여넣지 말고 Secrets에만 넣어 주세요.

## 화면 구성
하단 탭 5개 · 탭마다 소제목 목차(화면 위에 고정, 현재 위치 강조)
| 탭 | 소제목 |
|---|---|
| 홈 | 핵심 지표, 목차 |
| 원유·유제품 | 원유 수급, 원유 생산(연간·시도별), 우유·멸균유 수입, 분유 수입, 유청·대용유 원료 수입, 버터·치즈 수입 |
| 젖소·가축 | 젖소 사육·도축, 젖소 농장 규모, 젖소 산지가격, 젖소 도체 시세, 목장 수익성, 젖소 생산비, 육우 |
| 사료·조사료 | 배합사료 생산, 조사료 수입, 해외 조사료, 국제 곡물, 환율 |
| 더보기 | 유대·IOFC 계산기, 주간 시황, 상담 신청, KOSIS 통계표, 앱 설치 안내, 데이터 상태 |

지표 카드를 누르면 차트(월·분기 자료는 연도별 겹쳐보기, 연간 자료는 연도 추이)와 최근 값 표가 아래에서 올라옵니다. KOSIS 지표는 지역별·사육규모별·비용항목별 막대그래프도 함께 보여줍니다. 소제목 구성은 `app.js`의 `SECTIONS`, 홈 핵심 지표는 `HOME_KPIS`에서 바꿉니다.

## 휴대폰에 앱으로 설치
- **안드로이드(크롬·삼성 인터넷):** 화면 위 **＋ 앱 설치** 버튼, 또는 브라우저 메뉴 → 앱 설치/홈 화면에 추가
- **아이폰(사파리):** 공유 버튼(□↑) → 홈 화면에 추가 → 추가
- 설치하면 주소창 없이 앱처럼 열리고, 오프라인에서도 마지막으로 본 자료를 볼 수 있습니다. (GitHub Pages처럼 https 주소에서만 설치 가능)

## 로컬 실행
```bash
python3 collector/collect.py
python3 -m http.server 8000
```

## 공개 (GitHub Pages)
Settings → Pages → Branch: `main` / `(root)`
