import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const owningRoot = fs.existsSync(path.join(root, '../tools/env.sh')) ? path.resolve(root, '..') : root;
const temporaryRoot = path.join(owningRoot, 'project-data/tmp');
fs.mkdirSync(temporaryRoot, { recursive: true });
const temporary = fs.mkdtempSync(path.join(temporaryRoot, 'release-bot-'));
try {
  const notes = path.join(temporary, 'notes.md');
  const artifacts = ['standard.apk', 'compat.apk'].map(name => path.join(temporary, name));
  fs.writeFileSync(notes, 'Approved synthetic release notes');
  for (const file of artifacts) fs.writeFileSync(file, 'synthetic APK');
  const record = path.join(temporary, 'requests.jsonl');
  const mock = path.join(temporary, 'curl');
  fs.writeFileSync(mock, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const method = args.find(value => value.startsWith('https://')).split('/').at(-1);
fs.appendFileSync(process.env.CURL_RECORD, JSON.stringify({method, args}) + '\\n');
const scenario = process.env.SCENARIO;
if (scenario === 'network_failure') { process.stderr.write('synthetic-network-response-canary ' + args.join(' ')); process.exit(28); }
let response = {ok:true,result:{message_id:1}};
if (method === 'getMe') response.result = {id:123,is_bot:true,username:scenario === 'wrong_bot' ? 'synthetic_other_bot' : 'pipireleases_bot'};
if (method === 'getMe' && scenario === 'malformed') { process.stdout.write('invalid JSON'); process.exit(); }
if (method === 'getChat') response.result = {id:-100123,type:'channel'};
if (method === 'getChat' && scenario === 'bad_chat') response.ok = false;
if (method === 'getChatMember') response.result = {user:{id:123,is_bot:true},status:scenario === 'not_admin' ? 'member' : 'administrator', can_post_messages:scenario !== 'cannot_post'};
if (method === 'getChatMember' && scenario === 'post_missing') delete response.result.can_post_messages;
if (method === 'sendDocument' && scenario === 'send_failure') response.ok = false;
process.stdout.write(JSON.stringify(response));
`, { mode: 0o755 });
  function run(scenario, overrides = {}) {
    fs.writeFileSync(record, '');
    const result = spawnSync('/bin/bash', [path.join(root, 'tools/publish-telegram.sh'),
      'Pipi Deliveries v0.0.0', notes, artifacts[0]], {
      encoding: 'utf8', env: { PATH: `${temporary}:/usr/bin:/bin`,
        TELEGRAM_BOT_TOKEN: 'synthetic-token-canary', TELEGRAM_CHAT_ID: '@synthetic_channel',
        CURL_RECORD: record, SCENARIO: scenario, ...overrides },
    });
    assert.equal(result.error, undefined);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('synthetic-token-canary'));
    assert.ok(!`${result.stdout}${result.stderr}`.includes('synthetic-network-response-canary'));
    return { status: result.status,
      requests: fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) };
  }
  const success = run('success');
  assert.equal(success.status, 0);
  assert.deepEqual(success.requests.map(value => value.method),
    ['getMe', 'getChat', 'getChatMember', 'sendDocument', 'sendMessage']);
  assert.ok(success.requests[1].args.includes('chat_id=@synthetic_channel'));
  for (const request of success.requests.slice(2)) {
    assert.ok(request.args.includes('chat_id=-100123'));
  }
  const documents = success.requests.filter(value => value.method === 'sendDocument');
  assert.equal(documents.length, 1);
  assert.ok(documents[0].args.includes('document=@' + artifacts[0]));
  assert.ok(success.requests.every(request => !request.args.includes('document=@' + artifacts[1])));
  for (const scenario of ['wrong_bot', 'malformed', 'bad_chat', 'not_admin', 'cannot_post', 'post_missing', 'network_failure']) {
    const result = run(scenario);
    assert.notEqual(result.status, 0, scenario);
    assert.ok(result.requests.every(value => !value.method.startsWith('send')), scenario);
  }
  const failure = run('send_failure');
  assert.notEqual(failure.status, 0);
  assert.equal(failure.requests.filter(value => value.method.startsWith('send')).length, 1);
  const missing = run('success', { TELEGRAM_BOT_TOKEN: '' });
  assert.notEqual(missing.status, 0);
  assert.equal(missing.requests.length, 0);
  fs.writeFileSync(notes, 'x'.repeat(4097));
  const longNotes = run('success');
  assert.equal(longNotes.status, 0);
  assert.equal(longNotes.requests.at(-1).method, 'sendDocument');
  assert.ok(longNotes.requests.at(-1).args.includes('document=@' + notes));
  fs.truncateSync(artifacts[0], 50000001);
  const oversized = run('success');
  assert.notEqual(oversized.status, 0);
  assert.equal(oversized.requests.length, 0);
  fs.rmSync(artifacts[0]);
  fs.mkdirSync(artifacts[0]);
  const directory = run('success');
  assert.notEqual(directory.status, 0);
  assert.equal(directory.requests.length, 0, 'Directories must fail before any Bot API call');

  const workflow = fs.readFileSync(path.join(root, '.github/workflows/android.yml'), 'utf8');
  assert.ok(/notify-release:\n    if: startsWith\(github.ref, 'refs\/tags\/v'\)\n    needs: release-apk/.test(workflow), 'Telegram delivery must be a separate tag-only job after release');
  assert.ok(/TELEGRAM_BOT_TOKEN: \$\{\{ secrets.TELEGRAM_BOT_TOKEN \}\}/.test(workflow));
  assert.ok(/TELEGRAM_CHAT_ID: \$\{\{ secrets.TELEGRAM_CHAT_ID \}\}/.test(workflow));
  const notification = workflow.split('  notify-release:')[1];
  assert.ok(/bash tools\/publish-telegram.sh[\s\S]*Pipi-Deliveries-\$\{GITHUB_REF_NAME\}.apk/.test(notification), 'Deliver the standard APK');
  assert.ok(!notification.includes('-Android10.apk'), 'The Android 10 APK must not be sent to Telegram');
  console.log('Lite release bot preflight and delivery tests passed');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
