// 푸시 구독 접수 (Google Apps Script 웹 앱)
// - 이 스크립트는 '구독 저장 시트'(ipo_subscribe, 비공개)에 연결(컨테이너 바인딩)해서 쓴다.
// - 배포: 웹 앱 / 실행 계정 = 나 / 액세스 = 모든 사용자
// - 브라우저는 text/plain 으로 JSON 을 POST 한다.
//   1) 공모주 청약 알림 (탭 'subs'):  {"action":"subscribe"|"unsubscribe","endpoint":"...","keys":{"p256dh":"...","auth":"..."}}
//   2) 공포매매 단계 도달 알림 (탭 'fear'):
//        {"action":"fear_sync","endpoint":"...","k":{"p256dh":"...","auth":"..."},"state":{"done":["B1"],"avg":55.9,"held":45}}
//        {"action":"fear_off","endpoint":"..."}
//      (키 이름을 keys 가 아니라 k 로 쓰는 이유: 이 스크립트의 옛 버전이 fear_* 요청을 청약 구독으로 잘못 저장하지 않게)

var TAB = 'subs';
var MAX_SUBS = 3000;       // 저장 상한
var MAX_PER_MIN = 60;      // 분당 요청 상한 (스크립트 전체)
var FEAR_TAB = 'fear';     // 공포매매 알림 구독 (endpoint, p256dh, auth, state, updated)
var MAX_FEAR = 300;
var STAGES = ['B1', 'B2', 'B3', 'B4', 'B5', 'S1', 'S2', 'S3'];
// 알려진 푸시 서비스 주소만 허용 (엉뚱한 주소를 저장해 서버가 호출하게 만드는 공격 방지)
var ALLOWED = [
  /^https:\/\/fcm\.googleapis\.com\/.+/,
  /^https:\/\/updates\.push\.services\.mozilla\.com\/.+/,
  /^https:\/\/web\.push\.apple\.com\/.+/,
  /^https:\/\/[a-z0-9-]+\.push\.apple\.com\/.+/,
  /^https:\/\/[a-z0-9.-]+\.notify\.windows\.com\/.+/
];

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(TAB);
  if (!sh) {
    sh = ss.insertSheet(TAB);
    sh.getRange('A:D').setNumberFormat('@');          // 숫자/수식으로 바뀌지 않게 텍스트로 고정
    sh.appendRow(['endpoint', 'p256dh', 'auth', 'created']);
  }
  return sh;
}

function throttled_() {
  var c = CacheService.getScriptCache();
  var k = 'n' + Math.floor(Date.now() / 60000);
  var n = Number(c.get(k) || 0) + 1;
  c.put(k, String(n), 120);
  return n > MAX_PER_MIN;
}

// ---------- 공포매매 단계 도달 알림 ----------
function fearSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(FEAR_TAB);
  if (!sh) {
    sh = ss.insertSheet(FEAR_TAB);
    sh.getRange('A:E').setNumberFormat('@');
    sh.appendRow(['endpoint', 'p256dh', 'auth', 'state', 'updated']);
  }
  return sh;
}

// 앱이 보낸 상태({done:[끝낸 단계], avg:평단, held:보유수량})를 검증해서 JSON 문자열로 정리한다
function fearState_(st) {
  st = st || {};
  var src = Object.prototype.toString.call(st.done) === '[object Array]' ? st.done : [];
  var done = [];
  for (var i = 0; i < src.length; i++) {
    var s = String(src[i]);
    if (STAGES.indexOf(s) >= 0 && done.indexOf(s) < 0) done.push(s);
  }
  var avg = Number(st.avg), held = Number(st.held);
  if (!isFinite(avg) || avg < 0 || avg > 1000000) avg = 0;
  if (!isFinite(held) || held < 0 || held > 100000000) held = 0;
  return JSON.stringify({ done: done, avg: Math.round(avg * 10000) / 10000, held: Math.round(held * 10000) / 10000 });
}

function handleFear_(d, ep) {
  var sh = fearSheet_();
  var last = sh.getLastRow();
  var eps = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues() : [];
  var idx = -1;
  for (var i = 0; i < eps.length; i++) { if (eps[i][0] === ep) { idx = i + 2; break; } }

  if (d.action === 'fear_off') {                       // 끄기: 공포매매 명단에서만 빼고, 브라우저 푸시 구독 자체는 건드리지 않는다
    if (idx > 0) sh.deleteRow(idx);
    return json_({ ok: true });
  }

  var k = d.k || {};
  var p = String(k.p256dh || ''), a = String(k.auth || '');
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(p) || !/^[A-Za-z0-9_-]{20,30}$/.test(a)) {
    return json_({ ok: false, error: 'bad keys' });
  }
  var row = [ep, p, a, fearState_(d.state), new Date()];
  if (idx > 0) {                                       // 이미 있으면 키와 상태만 갱신
    sh.getRange(idx, 1, 1, 5).setValues([row]);
    return json_({ ok: true, updated: true });
  }
  if (eps.length >= MAX_FEAR) return json_({ ok: false, error: 'full' });
  sh.appendRow(row);
  return json_({ ok: true });
}

function doPost(e) {
  try {
    if (throttled_()) return json_({ ok: false, error: 'busy' });
    var raw = (e && e.postData && e.postData.contents) || '';
    if (raw.length > 2000) return json_({ ok: false, error: 'too large' });
    var d = JSON.parse(raw);
    var ep = String(d.endpoint || '');
    if (ep.length > 600 || !ALLOWED.some(function (r) { return r.test(ep); })) {
      return json_({ ok: false, error: 'bad endpoint' });
    }
    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      if (d.action === 'fear_sync' || d.action === 'fear_off') return handleFear_(d, ep);   // 공포매매 알림은 별도 탭 'fear'

      var sh = sheet_();
      var last = sh.getLastRow();
      var eps = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues() : [];
      var idx = -1;
      for (var i = 0; i < eps.length; i++) { if (eps[i][0] === ep) { idx = i + 2; break; } }

      if (d.action === 'unsubscribe') {                // 끄기: 내 구독 삭제
        if (idx > 0) sh.deleteRow(idx);
        return json_({ ok: true });
      }

      var k = d.keys || {};
      var p = String(k.p256dh || ''), a = String(k.auth || '');
      if (!/^[A-Za-z0-9_-]{80,100}$/.test(p) || !/^[A-Za-z0-9_-]{20,30}$/.test(a)) {
        return json_({ ok: false, error: 'bad keys' });
      }
      if (idx > 0) {                                   // 이미 있으면 키만 갱신
        sh.getRange(idx, 2, 1, 2).setValues([[p, a]]);
        return json_({ ok: true, updated: true });
      }
      if (eps.length >= MAX_SUBS) return json_({ ok: false, error: 'full' });
      sh.appendRow([ep, p, a, new Date()]);
      return json_({ ok: true });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: 'error' });
  }
}

function doGet() {
  return json_({ ok: true, service: 'ipo-push-subscribe' });
}
