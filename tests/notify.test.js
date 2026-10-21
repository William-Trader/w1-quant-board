'use strict';
const assert = require('assert');
const notify = require('../lib/notify');

assert.strictEqual(notify.buildPayload('telegram', 'hi').body.text, 'hi');
assert.strictEqual(notify.buildPayload('discord', 'hi').body.content, 'hi');
assert.strictEqual(notify.buildPayload('slack', 'hi').body.text, 'hi');
assert.strictEqual(notify.buildPayload('webhook', 'hi', { a: 1 }).body.meta.a, 1);
assert.strictEqual(notify.buildPayload('qq', 'hi').method, 'internal');
assert(Array.isArray(notify.channels()));

(async () => {
  const unknown = await notify.send({ channel: 'not_a_channel', text: 'x' });
  assert.strictEqual(unknown.ok, false);
  assert.strictEqual(unknown.error, 'unknown_channel');

  const cfg = notify.loadConfig();
  const first = Object.keys(cfg.channels || {})[0];
  if (first) {
    const dry = await notify.send({ channel: first, text: 'dry run', dryRun: true });
    assert.strictEqual(dry.ok, true);
    assert.strictEqual(dry.dryRun, true);
  }
  console.log('notify tests passed');
})().catch(e => { console.error(e); process.exit(1); });
