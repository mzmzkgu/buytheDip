# 공포매매 (buytheDip)

공포탐욕지수(F&G)와 VIX로 **TQQQ 분할매수(B1~B5)·분할매도(S1~S3)** 타이밍을 알려주고, 매매 기록을 관리하는 웹 도구입니다.
[소소한 재테크 작업실](https://mzmzkgu.github.io/fearbuy/)의 '공포매매' 탭에서 소개합니다.

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

규칙 숫자는 `app.js`의 `BUY_DEF`, `SELL_DEF`에 있습니다. 바꾸면 홈페이지의 공포매매 소개 글도 같이 고칩니다.

## 시세는 어디서 가져오나

별도 서버 없이, 사이트에 이미 있는 공개 데이터를 조합합니다. (코드는 `app.js`의 `SIGNALS_URL`, `PRICE_URL`)

| 값 | 출처 |
|---|---|
| F&G 지수·등급 | `mzmzkgu.github.io/marketTraffic/signals.json` → `assets.nasdaq.fg_score`, `fg_rating` (마켓시그널과 같은 데이터, 약 1시간마다 갱신) |
| 나스닥 지수·전일비 | 같은 파일의 `assets.nasdaq.price`, `change_pct` (`change_pct`는 `marketTraffic/backend/market_signal_updater.py`의 `build_fng_asset`이 전일 종가 대비로 계산) |
| VIX·구간 | 같은 파일의 `assets.vix.vix`, `vix_state` (20 미만 안정 / 20~30 불안 / 30 이상 공포) |
| 달러-원 환율 | 같은 파일의 `assets.usdkrw.price` |
| TQQQ 가격·전일비 | 무한매수가 쓰는 Cloudflare Worker의 `/price?ticker=TQQQ` (`price`, `change_pct`) |

- `signals.json` 구조(`assets.nasdaq`, `assets.vix`, `assets.usdkrw`)나 `change_pct` 필드가 바뀌면 `fetchMarket()`도 같이 고칩니다.
- 한쪽이 실패하면 그 값만 마지막으로 받은 값을 보여주고, 매매 입력 때 F&G·VIX·가격은 직접 적을 수 있습니다.
- F&G·VIX는 일 단위 지표라 `signals.json`의 갱신 주기로 충분합니다. TQQQ 가격만 Worker에서 그때그때 받아 옵니다.

## 단계 도달 알림 (웹 푸시)

옵션의 **단계 도달 알림**을 켜면 앱을 닫아도 B1~B5·S1~S3 조건에 도달했을 때 팝업이 뜹니다. **이미 끝낸(기록한) 단계는 알리지 않습니다.**

**서버에는 구독 정보(푸시 주소·키)만 저장합니다.** 끝낸 단계, 평단, 보유 수량 같은 값은 서버로 보내지 않고, 이 기기의 IndexedDB(`fearbuy`/`kv`/`alert`)에만 적어 둡니다.

```
앱(옵션에서 켜기) ──구독 정보만──▶ Apps Script ──▶ 비공개 구글 시트의 'fear' 탭
앱 ──끝낸 단계·평단·보유수량──▶ 이 기기의 IndexedDB (서버로 안 감)

Pi 크론(매시 5분) push_fear.py ──signals.json·TQQQ 시세로 '시장 조건'만 판정──▶ 모든 구독자에게 같은 푸시
기기의 sw.js ──IndexedDB 를 읽어 끝난 단계는 숨기고, 매도는 수익률 조건까지 확인──▶ 팝업
```

- 서버 쪽은 공모주 청약 알림과 같은 방식입니다: 같은 Apps Script 웹앱·VAPID 키·구독 시트를 쓰고, 탭만 `subs`(청약)와 `fear`(공포매매)로 나뉩니다.
- 서버는 매수(B1~B5)는 F&G·VIX 조건, 매도(S1~S3)는 F&G 조건만 보고, 수익률 조건은 기기가 자기 평단으로 확인합니다. 푸시 payload에 `fear: {fg, vix, price, buy[], sell[]}`가 들어 있어서 기기가 이 값으로 알림 문구를 다시 만듭니다.
- 판정 규칙은 `app.js`의 `BUY_DEF`·`SELL_DEF`, 서버 `ipo_info_sync/push_fear.py`, 그리고 `sw.js`가 받는 payload가 같은 표를 씁니다. **규칙을 바꾸면 앱과 push_fear.py를 같이 고쳐야 합니다.**
- 같은 방향의 단계가 한꺼번에 도달하면 알림 하나로 묶고, 한 번 알린 단계는 조건이 풀렸다가 다시 도달할 때까지 다시 알리지 않습니다. 매도는 F&G 조건이 유지되는 동안 TQQQ 가격이 마지막 발송 때보다 5% 이상 오르면(하루 1회 한도) 한 번 더 보냅니다. (수익률 조건은 기기에서만 알 수 있어서, 가격이 올라 조건을 넘는 경우를 놓치지 않기 위해)
- 끄면 공포매매 명단에서만 빼고 브라우저의 푸시 구독은 그대로 둡니다. (청약 알림과 같은 구독을 함께 쓰기 때문)
- 지원: 안드로이드 크롬 등은 권한만 허용하면 됩니다. 아이폰은 사이트를 홈 화면에 추가한 PWA에서만 푸시가 옵니다.

**알려진 한계**: 크롬 계열 브라우저는 푸시를 받으면 알림을 하나 보여야 합니다. 끝낸 단계라서 숨겨야 할 때는 소리 없는 알림을 띄우자마자 닫는 방식으로 처리하는데(`sw.js`의 `fear-hidden`), 기기에 따라 "사이트가 백그라운드에서 업데이트되었습니다" 같은 기본 알림이 보일 수 있습니다. 실제 기기에서 확인이 필요합니다.

### Apps Script 배포 (한 번만)

`apps_script/Code.gs`가 기존 청약 구독 스크립트에 `fear_sync`/`fear_off`를 더한 전체 코드입니다. 청약 구독 동작은 그대로입니다.

1. 구독 저장 시트(`ipo_subscribe`) → 확장 프로그램 → Apps Script
2. `Code.gs` 내용을 이 저장소의 `apps_script/Code.gs`로 **전체 교체**하고 저장
3. 배포 → 배포 관리 → 연필(편집) → 버전 **새 버전** → 배포 (웹 앱 주소는 그대로 유지됩니다)
4. 앱에서 알림을 켜면 시트에 `fear` 탭이 자동으로 생깁니다

배포 전에는 앱에서 켜도 "알림 서버가 아직 준비되지 않았어요"가 나오고 스위치가 꺼진 채로 돌아옵니다.

### 발송 (Pi)

```bash
cd ~/Desktop/ipo_info_sync
./venv/bin/python push_fear.py --list       # 구독 수
./venv/bin/python push_fear.py --dry-run    # 무엇을 보낼지 출력만 (발송·기록 없음)
./venv/bin/python push_fear.py --test       # 'fear' 구독자에게만 테스트 알림
# 크론 예: 5 * * * *  (marketTraffic 갱신 직후, flock 으로 중복 실행 방지)
```

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

## 포함된 라이브러리

- `vendor/chart.umd.min.js`: [Chart.js](https://www.chartjs.org/) 4.4.0 (MIT 라이선스). 외부 CDN이 막히는 환경에서도 차트가 그려지도록 같은 도메인에 함께 둡니다.
