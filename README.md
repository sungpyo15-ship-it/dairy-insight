# DAIRY INSIGHT · 낙농 인사이트

낙농 시장정보 웹앱(PWA) 시제품입니다. 한우 인사이트와는 별도 저장소로 운영합니다.

> ⚠ 현재 `data/market.json`의 수치는 화면 확인용 **샘플 데이터**이며 실제 시장 수치가 아닙니다.

## 구성
| 경로 | 내용 |
|---|---|
| `index.html`, `app.js`, `styles.css` | 앱 화면 (시세 · 계산기 · 시황 · 상담) |
| `data/market.json` | 지표·시황 데이터 (이 파일만 고치면 화면 전체 반영) |
| `manifest.webmanifest`, `sw.js` | 휴대폰 홈 화면 설치·오프라인 지원 |
| `docs/낙농시장정보앱_기획서.md` | 기획서 |

## 로컬 실행
```bash
python3 -m http.server 8000
```
브라우저에서 http://localhost:8000 접속

## 공개 (GitHub Pages)
Settings → Pages → Branch: `main` / `(root)` 선택 후 저장
