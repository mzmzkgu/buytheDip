# 줍줍매매 (buytheDip)

공포탐욕지수(F&G)와 VIX로 **TQQQ 분할매수(B1~B5)·분할매도(S1~S3)** 타이밍을 알려주고, 매매 기록을 관리하는 웹 도구입니다.
[소소한 재테크 작업실](https://mzmzkgu.github.io/jupjup/)의 '줍줍매매' 탭에서 소개합니다.

- 주소: https://mzmzkgu.github.io/buytheDip/
- 정적 페이지(`index.html`, `style.css`, `app.js`)라서 빌드 없이 GitHub Pages로 서비스합니다.
- 매매 기록 저장 위치는 **둘 중 하나**입니다. (옵션의 "저장 위치")
  - **로컬(기본)**: 브라우저 localStorage(`buythedip_v1`)에만 저장하고 서버로 보내지 않습니다. JSON 백업 내보내기/가져오기를 지원합니다. (브라우저 데이터를 지우면 기록도 사라집니다)
  - **구글 시트**: Apps Script 웹앱 주소를 넣으면 그 시트에서 읽고 씁니다. 주소를 다시 비우면 로컬 기록이 그대로 돌아옵니다.

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

## 구글 시트 모드

옵션의 **저장 위치**에 Apps Script 웹앱 주소(`https://script.google.com/macros/s/…/exec`)를 넣고 저장하면 시트 모드가 됩니다.
브라우저는 시트를 직접 고칠 수 없어서, 시트에 연결된 Apps Script 웹앱이 대신 읽고 씁니다. (예전 버전에서 쓰던 스크립트를 그대로 씁니다)

| 하는 일 | 호출하는 action |
|---|---|
| 회차(탭) 목록 | `listtabs` |
| 회차 읽기 (8단계 행 + `summary.total_seed_usd`) | `read` (`tab`) |
| 매매 저장 | `write` (`tab`, 본문 `stage,date,trade_price,qty,fx,fg,vix`) |
| 매매 삭제 | `deleterow` (`tab`, 본문 `stage`) |
| 회차 추가 | `copytab` (본문 `source,target`) + `settotalseed` |
| 시드 변경 | `settotalseed` (`tab`, 본문 `value`) |

- 평균단가·수익률 같은 계산은 앱이 직접 하고, 시트에서는 행 값과 시드만 읽습니다.
- 저장할 때마다 그 탭을 시트에서 다시 읽어 화면을 맞춥니다.
- 시트 모드에서는 회차 이름 변경·삭제와 JSON 백업을 쓰지 않습니다. (탭 이름 변경·삭제는 구글 시트에서 직접 하세요)
- **웹앱 주소를 아는 사람은 시트를 고칠 수 있습니다.** 주소는 이 브라우저의 localStorage에만 저장하고, 백업 파일에는 넣지 않습니다.
- 시트 모드에서 읽어 둔 회차는 옵션의 **시트 회차를 이 브라우저로 복사**로 로컬에 옮길 수 있습니다. (시트는 바뀌지 않습니다)
- 회차가 아닌 탭은 `read`가 실패하므로 목록에서 자동으로 빠집니다.

## 로컬에서 보기

```bash
python3 -m http.server 8123   # http://127.0.0.1:8123/
```

투자 권유가 아닌 참고용 기록 도구입니다.
