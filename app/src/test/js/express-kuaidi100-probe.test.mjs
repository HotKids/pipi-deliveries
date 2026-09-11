import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';

const java = readFileSync(new URL('../../main/java/me/pipi/deliveries/feature/express/ExpressKuaidi100TimelineCapture.java', import.meta.url), 'utf8');
const body = java.slice(java.indexOf('static String extractionScript() {'));
const expression = body.slice(body.indexOf('return ') + 7, body.indexOf(';\n    }'))
  .replaceAll('MAX_TRACKS', java.match(/MAX_TRACKS = (\d+)/)[1]);
const probe = runInNewContext(expression);
const latest = { time: '2026-09-09 18:51:23', context: 'Synthetic latest event' };
const first = { time: '2026-09-08 09:00:00', context: 'Synthetic pickup event' };

function extract(rootSelector, hostname = 'm.kuaidi100.com') {
  const vue = { lists: [latest], alllists: [latest, first], time: () => 'not an event' };
  return JSON.parse(runInNewContext(probe, {
    location: { hostname }, window: {}, document: {
      readyState: 'complete',
      querySelector: selector => selector === '#main' && rootSelector === '#main'
        ? { __vue__: vue } : null,
      querySelectorAll: selector => selector.split(',').includes(rootSelector)
        ? [{ __vue__: vue }] : [],
    },
  })).tracks;
}

// The fixed app/query page mounts Vue at #main; its lists share nodes with alllists.
assert.deepEqual(extract('#main'), [latest, first]);
for (const legacyRoot of ['body', '#app', '.container']) {
  assert.deepEqual(extract(legacyRoot), [latest, first]);
}
assert.deepEqual(extract('#main', 'unrelated.invalid'), []);
console.log('K100 #main Vue, legacy roots, deduplication and host boundary passed');

function diagnosticSnapshot(readyState, main) {
  return JSON.parse(runInNewContext(probe, {
    location: { hostname: 'm.kuaidi100.com' }, window: {}, document: {
      readyState, querySelector: () => main, querySelectorAll: () => [],
    },
  }));
}
for (const show of [true, false]) {
  const snapshot = diagnosticSnapshot('complete', { __vue__: {
    checkCode: { show, value: 'withheld-code', phone: 'withheld-phone' },
  }});
  assert.deepEqual(snapshot.diagnostics,
    { mainPresent: true, readyState: 'complete', checkCodeVisible: show, phoneVerificationAttempted: false });
  assert.equal(JSON.stringify(snapshot).includes('withheld'), false);
}
assert.deepEqual(diagnosticSnapshot('loading', null).diagnostics,
  { mainPresent: false, readyState: 'loading', checkCodeVisible: null, phoneVerificationAttempted: false });
assert.deepEqual(diagnosticSnapshot('withheld-state', { __vue__: { checkCode: { show: 'withheld' } } }).diagnostics,
  { mainPresent: true, readyState: 'unknown', checkCodeVisible: null, phoneVerificationAttempted: false });
console.log('K100 bounded page diagnostics and unknown-field semantics passed');

function verificationProbe(number, tail) {
  const marker = 'static String verificationScript(String waybill, List<String> phones) {';
  if (!java.includes(marker)) return '';
  const method = java.slice(java.indexOf(marker));
  const expression = method.slice(method.indexOf('return "(function') + 7, method.indexOf(';\n    }'));
  return runInNewContext(expression, { number, candidates: JSON.stringify([tail]), JSONObject: { quote: JSON.stringify } });
}

function verifyPhone({ tail = '1234', number = 'SFTEST4271', pageNumber = 'SFTEST4271',
    hostname = 'm.kuaidi100.com', protocol = 'https:', pathname = '/app/query/',
    search = '?nu=SFTEST4271', challenge = true, throws = false } = {}) {
  let submitted = 0, writes = 0, privateReads = 0;
  const checkCode = { show: challenge };
  Object.defineProperty(checkCode, 'value', {
    enumerable: true,
    set(value) { assert.equal(value, tail); writes++; },
    get() { privateReads++; throw new Error('input must not be read back'); },
  });
  const vue = { num: pageNumber, checkCode, aliasedCheckCode: checkCode,
    doCheckCode() { submitted++; if (throws) throw new Error('withheld-page-error'); },
  };
  const context = { window: {}, URL, location: { hostname, protocol, pathname,
      href: protocol + '//' + hostname + pathname + search },
    document: { readyState: 'complete', querySelector: () => ({ __vue__: vue }),
      querySelectorAll: selector => selector === 'body,#main,#app,.container' ? [{ __vue__: vue }] : [] },
  };
  const script = verificationProbe(number, tail);
  runInNewContext(script, context);
  runInNewContext(script, context);
  const result = runInNewContext(probe, context);
  assert.equal(result.includes(tail) && tail.length > 0, false);
  assert.equal(privateReads, 0);
  return { submitted, writes };
}
assert.deepEqual(verifyPhone(), { submitted: 1, writes: 1 });
assert.deepEqual(verifyPhone({ throws: true }), { submitted: 1, writes: 1 });
for (const invalid of [{ challenge: false }, { tail: '' }, { tail: '123' }, { tail: '12a4' },
  { tail: '12345' }, { pageNumber: 'OTHER4271' }, { number: '' },
  { hostname: 'unrelated.invalid' }, { hostname: 'www.kuaidi100.com' },
  { protocol: 'http:' }, { pathname: '/result/' }, { search: '?nu=OTHER4271' },
  { search: '?nu=SFTEST4271&nu=SFTEST4271' }, { search: '' }]) {
  assert.deepEqual(verifyPhone(invalid), { submitted: 0, writes: 0 });
}
console.log('K100 same-parcel phone challenge, one submission, and no readback passed');

function challengeRound(tails) {
  const marker = 'static String verificationScript(String waybill, List<String> phones) {';
  const method = java.slice(java.indexOf(marker));
  const expression = method.slice(method.indexOf('return "(function') + 7, method.indexOf(';\n    }'));
  const script = runInNewContext(expression, { number: 'SFTEST1', candidates: JSON.stringify(tails),
    JSONObject: { quote: JSON.stringify } });
  const submitted = [];
  const checkCode = { show: true };
  Object.defineProperty(checkCode, 'value', { set: value => submitted.push(value) });
  const vue = { num: 'SFTEST1', checkCode, loading: false, errors: { type: '' },
    doCheckCode() { this.loading = true; this.checkCode.show = false; },
  };
  const context = { URL, window: {}, location: { protocol: 'https:', hostname: 'm.kuaidi100.com',
    pathname: '/app/query/', href: 'https://m.kuaidi100.com/app/query/?nu=SFTEST1' },
    document: { querySelector: () => ({ __vue__: vue }) },
  };
  return { vue, submitted, context, run: () => runInNewContext(script, context) };
}
const retry = challengeRound(['1234', '5678']);
retry.run();
retry.run();
assert.deepEqual(retry.submitted, ['1234']);
retry.vue.loading = false;
retry.vue.checkCode.show = true;
retry.run();
assert.deepEqual(retry.submitted, ['1234', '5678']);
retry.vue.loading = false;
retry.vue.checkCode.show = true;
retry.run();
assert.equal(retry.context.window.__pipiK100PhoneState.outcome, 'phone_required');
const network = challengeRound(['1234', '5678']);
network.run();
network.vue.loading = false;
network.vue.checkCode.show = true;
network.vue.errors.type = 'network';
network.run();
assert.deepEqual(network.submitted, ['1234']);
assert.equal(network.context.window.__pipiK100PhoneState.outcome, 'provider_error');
const absent = challengeRound([]);
absent.run();
assert.equal(absent.context.window.__pipiK100PhoneState.outcome, 'phone_required');
const notStarted = challengeRound(['1234', '5678']);
notStarted.vue.doCheckCode = () => {};
notStarted.run();
notStarted.run();
assert.deepEqual(notStarted.submitted, ['1234']);
assert.equal(notStarted.context.window.__pipiK100PhoneState.outcome, 'pending');
console.log('K100 fresh request-phase rejection retries and network separation passed');
