import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';

const java = readFileSync(new URL('../../main/java/me/pipi/deliveries/feature/express/ExpressKuaidi100TimelineCapture.java', import.meta.url), 'utf8');
const method = java.slice(java.indexOf('static String jtExtractionScript('));
const expression = method.slice(method.indexOf('return "(function') + 7, method.indexOf(';\n    }'))
  .replaceAll('MAX_TRACKS', java.match(/MAX_TRACKS = (\d+)/)[1]);
const number = 'JTTEST123456';
const row = { time: '2026-09-10 10:00', status: '已揽件', context: 'Synthetic parcel collected' };

function page(tails = ['1234']) {
  const state = { visible: true, value: '', writes: [], events: 0, toast: '', toastVisible: true, header: number, rows: [] };
  function Input() {}
  Object.defineProperty(Input.prototype, 'value', {
    get() { return state.value; },
    set(value) { state.writes.push(value); state.value = value; },
  });
  const input = new Input();
  input.dispatchEvent = event => { assert.equal(event.type, 'input'); state.events++; };
  const popup = { getClientRects: () => state.visible ? [{}] : [], querySelector: () => input };
  const rowNode = item => ({ querySelector: selector => ({
    '.scdrlr-time': { textContent: item.time },
    '.scdrl-left': { textContent: item.status },
    '.scdrl-right': { children: [
      { textContent: item.context, classList: { contains: () => false } },
      { textContent: item.time, classList: { contains: () => true } },
    ] },
  })[selector] });
  const context = {
    URLSearchParams, HTMLInputElement: Input, Event: class { constructor(type) { this.type = type; } },
    window: {}, location: { protocol: 'https:', hostname: 'jtsd.jtexpress.com.cn', pathname: '/pipi',
      hash: '#/pages/checkGoods/sendDetail?waybillNo=' + number + '&isFrom=serach' },
    document: { readyState: 'complete',
      querySelector: selector => ({ '.query-popup': popup,
        '.scft-left .cgsllt-right': { textContent: state.header },
        '.uni-toast__content': { textContent: state.toast, getClientRects: () => state.toast && state.toastVisible ? [{}] : [] },
      })[selector],
      querySelectorAll: selector => selector === '.scd-route .scdr-list' ? state.rows.map(rowNode) : [],
    },
  };
  const script = runInNewContext(expression, {
    number, candidates: JSON.stringify(tails), JSONObject: { quote: JSON.stringify },
  });
  return { state, context, read: () => JSON.parse(runInNewContext(script, context)) };
}

const valid = page();
assert.equal(valid.read().outcome, 'pending');
valid.read();
assert.deepEqual(valid.state.writes, ['1234']);
assert.equal(valid.state.events, 1);
valid.state.visible = false;
valid.state.rows = [row];
assert.deepEqual(valid.read().tracks, [{ time: row.time, context: row.status + ' ' + row.context }]);
assert.equal(JSON.stringify(valid.read()).includes('1234'), false);
valid.state.header = 'JTOTHER';
assert.deepEqual(valid.read().tracks, []);

for (const change of [
  { protocol: 'http:' }, { hostname: 'unrelated.invalid' }, { pathname: '/other' },
  { hash: '#/pages/checkGoods/sendDetail?waybillNo=OTHER' },
  { hash: '#/pages/checkGoods/sendDetail?waybillNo=' + number + '&waybillNo=' + number },
  { hash: '#/other?waybillNo=' + number },
]) {
  const wrong = page();
  Object.assign(wrong.context.location, change);
  assert.equal(wrong.read().tracks.length, 0);
  assert.equal(wrong.state.events, 0);
}

assert.equal(page([]).read().outcome, 'phone_required');
const rejected = page(['1234', '5678']);
rejected.read();
rejected.state.value = '';
assert.equal(rejected.read().outcome, 'pending'); // Clearing alone does not prove a mismatch.
assert.equal(rejected.state.events, 1);
rejected.state.toast = '手机尾号不匹配';
assert.equal(rejected.read().outcome, 'pending');
assert.equal(rejected.read().outcome, 'pending');
assert.equal(rejected.read().outcome, 'pending');
assert.deepEqual(rejected.state.writes, ['1234']);
assert.equal(rejected.state.events, 1);
rejected.state.toastVisible = false;
assert.equal(rejected.read().outcome, 'pending');
assert.deepEqual(rejected.state.writes, ['1234', '5678']);
rejected.state.value = '';
assert.equal(rejected.read().outcome, 'pending');
rejected.state.toastVisible = true;
assert.equal(rejected.read().outcome, 'phone_required');
const unavailable = page();
unavailable.read();
unavailable.state.value = '';
unavailable.state.toast = '服务暂时不可用';
assert.equal(unavailable.read().outcome, 'provider_error');
console.log('JT DOM identity, ordinary verification, candidate retry and phone/network separation passed');
