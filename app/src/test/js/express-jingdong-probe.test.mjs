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
