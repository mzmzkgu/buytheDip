# 줍줍매매 (buytheDip)

공포탐욕지수(F&G)와 VIX로 **TQQQ 분할매수(B1~B5)·분할매도(S1~S3)** 타이밍을 알려주고, 매매 기록을 관리하는 웹 도구입니다.
[소소한 재테크 작업실](https://mzmzkgu.github.io/jupjup/)의 '줍줍매매' 탭에서 소개합니다.

- 주소: https://mzmzkgu.github.io/buytheDip/
- 정적 페이지(`index.html`, `style.css`, `app.js`)라서 빌드 없이 GitHub Pages로 서비스합니다.
- 매매 기록은 **브라우저 localStorage(`buythedip_v1`)에만** 저장합니다. 서버·구글시트로 보내지 않습니다.
- 옵션에서 JSON 백업 내보내기/가져오기를 지원합니다. (브라우저 데이터를 지우면 기록도 사라집니다)

## 매매 규칙

| 단계 | 조건 | 비중 |
|---|---|---|
| B1 | F&G ≤ 25 그리고 VIX ≥ 20 | 시드의 10% |
| B2 | F&G ≤ 20 그리고 VIX ≥ 25 | 15% |
| B3 | F&G ≤ 15 그리고 VIX ≥ 30 | 20% |
| B4 | F&G ≤ 10 그리고 VIX ≥ 35 | 25% |
| B5 | F&G ≤ 5 **또는** VIX ≥ 40 | 30% |
| S1 | F&G ≥ 65 그리고 수익률 ≥ 10% | 평가액의 20% |
| S2 | F&G ≥ 70 그리고 수익률 ≥ 20% | 30% |
| S3 | F&G ≥ 75 (수익률 0% 이상) | 50% |

규칙 숫자는 `app.js`의 `BUY_DEF`, `SELL_DEF`에 있습니다. 바꾸면 홈페이지의 줍줍매매 소개 글도 같이 고칩니다.

## 시세는 어디서 가져오나

별도 서버 없이, 사이트에 이미 있는 공개 데이터를 조합합니다. (코드는 `app.js`의 `SIGNALS_URL`, `PRICE_URL`)

| 값 | 출처 |
|---|---|
| F&G 지수·등급 | `mzmzkgu.github.io/marketTraffic/signals.json` → `assets.nasdaq.fg_score`, `fg_rating` (마켓시그널과 같은 데이터, 약 1시간마다 갱신) |
| VIX | 같은 파일의 `assets.vix.vix` |
| 달러-원 환율 | 같은 파일의 `assets.usdkrw.price` |
| TQQQ 가격 | 무한매수가 쓰는 Cloudflare Worker의 `/price?ticker=TQQQ` |

- `signals.json` 구조(`assets.nasdaq`, `assets.vix`, `assets.usdkrw`)가 바뀌면 `fetchMarket()`도 같이 고칩니다.
- 한쪽이 실패하면 그 값만 마지막으로 받은 값을 보여주고, 매매 입력 때 F&G·VIX·가격은 직접 적을 수 있습니다.
- F&G·VIX는 일 단위 지표라 `signals.json`의 갱신 주기로 충분합니다. TQQQ 가격만 Worker에서 그때그때 받아 옵니다.

## 구글 시트에서 옮겨 오기

예전 버전(구글 시트 + Apps Script)을 쓰던 경우, 옵션의 **구글 시트에서 가져오기**에 Apps Script 웹앱 주소를 넣으면 매매기록이 있는 탭을 회차로 읽어 옵니다. 시트는 읽기만 하고 바꾸지 않습니다.

## 로컬에서 보기

```bash
python3 -m http.server 8123   # http://127.0.0.1:8123/
```

투자 권유가 아닌 참고용 기록 도구입니다.
