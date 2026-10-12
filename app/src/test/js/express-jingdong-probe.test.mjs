import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
const java = readFileSync(new URL('../../main/java/me/pipi/deliveries/feature/express/ExpressJingDongTimelineParser.java', import.meta.url), 'utf8');
const body = java.slice(java.indexOf('static String probeScript() {'));
const expression = body.slice(body.indexOf('return ') + 7, body.indexOf(';\n    }')).replaceAll('MAX_CAPTURED_BODY_CHARS', '1500000');
const probe = runInNewContext(expression);
const tick = () => new Promise(resolve => setImmediate(resolve));
const payload = JSON.stringify({data:{floors:[{element:{info:{waybillCode:'JD123456789012', traceList:[{operateTime:'2026-09-08 12:00:00',operateMessage:'synthetic'}]}}}]}});
function harness(throws = false) {
  let resolveBefore, resolveClick, clickCount = 0;
  const before = new Promise(resolve => { resolveBefore = resolve; });
  const after = new Promise(resolve => { resolveClick = resolve; });
  let calls = 0;
  let button = null;
  function XHR() {}
  XHR.prototype.open = function(){};
  XHR.prototype.send = function(){};
  XHR.prototype.setRequestHeader = function(){};
  const context = {
    window: { fetch: () => ++calls === 1 ? before : after },
    document: {querySelector: selector => selector === '.logistics-button' ? button : null,
      querySelectorAll: () => []}, XMLHttpRequest: XHR,
  };
  const run = () => runInNewContext(probe, context);
  run();
  context.window.fetch('https://api.m.jd.com?functionId=getUnionActivity');
  const response = {status:200, headers:{get:()=>''},clone:()=>({text:async()=>payload})};
  return { run, context,
    click: () => { button = {querySelector:()=>({innerText:'完整物流进度 >'}),click:()=>{
      clickCount++; context.window.fetch('https://api.m.jd.com?functionId=getUnionActivity');
      if(throws) throw new Error('synthetic click rejected');
    }}; run(); },
    settle:async()=>{resolveBefore(response);resolveClick(response);await tick();},
    proofs:()=>Array.from(context.window.__pipiJdUnionCaptures,entry=>JSON.parse(entry).fullProgressRequestedAtStart),
    clicks:()=>clickCount,
  };
}
const valid = harness();
valid.click();
await valid.settle();
assert.deepEqual(valid.proofs(),[false,true]);
assert.equal(valid.clicks(),1);
const rejected = harness(true);
rejected.click();
await rejected.settle();
assert.deepEqual(rejected.proofs(),[false,false], 'a rejected click cannot prove its pending request complete');
console.log('JD probe request-start and rejected-click causality passed');

// The document-start probe runs before the modal exists. A later poll must still publish it.
{
  let mounted = false;
  let clicked = false;
  function XHR() {}
  XHR.prototype.open = function(){}; XHR.prototype.send = function(){};
  const row = { querySelector: selector => ({innerText: selector === '.status-time' ?
    '2026-09-08 12:00:00' : selector === '.status-msg' ? 'synthetic modal node' : '运输中'}) };
  const ctx = {window:{},XMLHttpRequest:XHR,document:{
    querySelector: selector => selector === '.logistics-button' && mounted ?
      {querySelector:()=>({innerText:'完整物流进度 >'}),click:()=>{clicked=true;}} :
      selector === '.logistics-top-narrow' && clicked ? {innerText:'京东快递 JD123456789012 复制'} : null,
    querySelectorAll: () => clicked ? [row] : [],
  }};
  runInNewContext(probe,ctx);
  mounted=true;
  runInNewContext(probe,ctx);
  assert.equal(ctx.window.__pipiJdUnionCaptures?.length,1,'late modal must be captured after document-start probe');
  assert.equal(JSON.parse(ctx.window.__pipiJdUnionCaptures[0]).source,'dom');
}
console.log('JD late-mounted modal capture passed');

// 用户 2026-09-25 同意（方案 A，三端同一口径）：轮询把判空壳要看的页面状态一并读回来——加载完没有、视口、风控、
// 网络节点、运单号和出错的 union 请求（e）。不带物流的 200 应答照样排进队列，却没有网络节点、没有运单号（队列里的包
// 带不带物流由 Java 端判）；带节点和运单号的应答才会点亮 n 和 u；非 2xx 或网络失败的 union 请求计进 e。
{
  const readBody = java.slice(java.indexOf('static String readScript() {'));
  const read = runInNewContext(readBody.slice(readBody.indexOf('return ') + 7, readBody.indexOf(';\n    }'))
    .replace('probeScript()', JSON.stringify(probe)));
  function XHR() { this.listeners = {}; }
  XHR.prototype.open = function(){};
  XHR.prototype.send = function(){};
  XHR.prototype.addEventListener = function(type, listener) { this.listeners[type] = listener; };
  XHR.prototype.getResponseHeader = function(name) { return name === 'content-type' ? 'application/json' : null; };
  let answer;
  const page = {
    window: { innerWidth: 412, innerHeight: 915,
      fetch: () => new Promise(resolve => { answer = resolve; }) },
    document: { readyState: 'complete', querySelector: () => null, querySelectorAll: () => [] },
    XMLHttpRequest: XHR,
  };
  const state = () => JSON.parse(runInNewContext(read, page));
  const reply = body => ({status:200, headers:{get:name => name === 'content-type' ? 'application/json' : null},
    clone:()=>({text:async()=>body})});
  assert.deepEqual(state(), {q:[],k:false,n:0,u:false,e:0,p:0,r:'complete',w:412,h:915},
    'a loaded page that captured nothing');
  page.window.fetch('https://api.m.jd.com?functionId=getUnionActivity');
  // 用户 2026-09-26（其余裁决 4）：发出去、还没回的 union 请求计进 p；回了（或失败）就减掉。
  assert.equal(state().p, 1, 'a union fetch sent and not yet answered is pending');
  answer(reply('{"code":"0","data":{"floors":[{"element":{"info":{"traceList":[]}}}]}}'));
  await tick();
  assert.equal(state().p, 0, 'an answered union fetch is no longer pending');
  const bare = state();
  assert.equal(bare.q.length, 1, 'a bare 200 answer is queued like any other');
  assert.equal(bare.n, 0, 'but it carries no network nodes');
  assert.equal(bare.u, false, 'and no waybill');
  const request = new page.XMLHttpRequest();
  request.open('POST', 'https://api.m.jd.com/client.action');
  request.send('functionId=getUnionActivity&body=%7B%7D');
  assert.equal(state().p, 1, 'a union XHR sent and not yet answered is pending');
  request.status = 200;
  request.responseText = '<html>system busy</html>';
  request.listeners.load.call(request);
  assert.deepEqual(state().q, bare.q, 'an unreadable answer is not queued at all');
  page.window.fetch('https://api.m.jd.com?functionId=getUnionActivity');
  answer(reply(payload));
  await tick();
  assert.equal(state().n, 1, 'a union answer with a timed node lights the network nodes');
  assert.equal(state().u, true, 'and its waybill');
  assert.equal(state().e, 0, 'every union answer so far was 2xx');

  // 用户 2026-09-25 补充：union 请求回了非 2xx 或网络失败，与风控一样既不算空壳也不清零；页面自己照样收到失败。
  page.window.fetch('https://api.m.jd.com?functionId=getUnionActivity');
  answer({status:502, headers:{get:() => null}, clone:()=>({text:async()=>'Bad Gateway'})});
  await tick();
  assert.equal(state().e, 1, 'a non-2xx fetch answer is a union error');
  const failed = page.window.fetch('https://api.m.jd.com?functionId=getUnionActivity');
  answer(Promise.reject(new TypeError('Failed to fetch')));
  await assert.rejects(failed, TypeError, 'the page still sees its own network failure');
  assert.equal(state().e, 2, 'a failed fetch is a union error');
  const broken = new page.XMLHttpRequest();
  broken.open('POST', 'https://api.m.jd.com/client.action');
  broken.send('functionId=getUnionActivity&body=%7B%7D');
  broken.status = 500;
  broken.responseText = '{"code":"500"}';
  broken.listeners.load.call(broken);
  assert.equal(state().e, 3, 'a non-2xx XHR answer is a union error');
  const offline = new page.XMLHttpRequest();
  offline.open('POST', 'https://api.m.jd.com/client.action');
  offline.send('functionId=getUnionActivity&body=%7B%7D');
  offline.listeners.error.call(offline);
  assert.equal(state().e, 4, 'an XHR network error is a union error');
  const slow = new page.XMLHttpRequest();
  slow.open('POST', 'https://api.m.jd.com/client.action');
  slow.send('functionId=getUnionActivity&body=%7B%7D');
  slow.listeners.timeout.call(slow);
  assert.equal(state().e, 5, 'an XHR timeout is a union error');
  const other = new page.XMLHttpRequest();
  other.open('POST', 'https://api.m.jd.com/client.action');
  other.send('functionId=somethingElse');
  assert.equal(other.listeners.error, undefined, 'other requests are not watched');
  assert.equal(state().p, 0, 'every union request so far answered or failed');
  const aborted = new page.XMLHttpRequest();
  aborted.open('POST', 'https://api.m.jd.com/client.action');
  aborted.send('functionId=getUnionActivity&body=%7B%7D');
  // The page aborts it: no load, error or timeout ever comes, so it never answers and stays pending.
  assert.equal(state().p, 1, 'a union request the page never gets an answer to stays pending');
  assert.equal(state().e, 5, 'an unanswered request is not counted as an error');
  aborted.listeners.load.call(Object.assign(aborted, {status: 200, responseText: '{}'}));
  aborted.listeners.load.call(aborted);
  assert.equal(state().p, 0, 'a late answer settles it once, never below zero');
  page.window.innerWidth = 0;
  page.document.readyState = 'interactive';
  assert.equal(state().w, 0);
  assert.equal(state().r, 'interactive');
}
console.log('JD page state for the empty-shell judgement passed');
