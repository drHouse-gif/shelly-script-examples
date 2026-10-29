// SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'solax-x3-hybrid-g4-dashboard.shelly.js'),
  'utf8'
);

function start(options = {}) {
  const manifest = JSON.parse(source.split('\n')[0].slice(9, -3)).vc;
  const handles = {};
  const calls = [];
  const timers = [];
  const logs = [];
  const configWrites = [];
  let failRequest = options.failRequest;

  for (const [index, role] of Object.keys(manifest).entries()) {
    const definition = manifest[role];
    let config = { id: 201 + index * 3, ...definition.config };
    let value = role === 'sn' ? (options.sn ?? 'TEST123456') : null;
    const listeners = {};
    handles[role] = {
      getConfig: () => config,
      setConfig: update => {
        configWrites.push(role);
        config = { ...config, ...update };
      },
      getValue: () => value,
      setValue: next => {
        if (definition.type === 'number') {
          assert.ok(Number.isFinite(next));
          assert.ok(next >= config.min && next <= config.max);
        }
        value = next;
      },
      on: (event, callback) => {
        listeners[event] = callback;
      },
      change: next => {
        value = next;
        if (listeners.change) listeners.change({ value: next });
      },
    };
  }

  const context = vm.createContext({
    Script: {
      getVcHandle: role => (role === options.missingRole ? null : handles[role]),
    },
    Shelly: {
      call: (method, params, callback, userdata) => {
        if (method === 'HTTP.POST' && failRequest) {
          failRequest = false;
          throw new Error('RPC capacity exhausted');
        }
        calls.push({ method, params, callback, userdata });
      },
    },
    Timer: {
      set: (period, repeat, callback) => timers.push({ period, repeat, callback }),
    },
    print: (...args) => logs.push(args.join(' ')),
  });
  const script = options.placeholderIp
    ? source
    : source.replace("ip: '192.0.2.10'", "ip: '198.51.100.10'");
  vm.runInContext(script, context);

  function finishGroup(error = 0) {
    const call = calls.find(item => item.method === 'Group.Set');
    assert.ok(call, 'startup should configure the group');
    call.callback(null, error);
  }

  function reply(body, error = 0, code = 200, index = 0) {
    const call = calls.filter(item => item.method === 'HTTP.POST')[index];
    assert.ok(call, 'a request should exist');
    const result = error ? undefined : { code, body: JSON.stringify(body) };
    call.callback(result, error, error ? 'Transport failure' : '', call.userdata);
  }

  return {
    handles,
    calls,
    timers,
    logs,
    configWrites,
    context,
    finishGroup,
    reply,
    requests: () => calls.filter(item => item.method === 'HTTP.POST'),
  };
}

function snapshot() {
  const Data = Array(300).fill(0);
  Data[14] = 2400;
  Data[15] = 700;
  Data[19] = 2;
  Data[34] = 65036;
  Data[35] = 65535; // Signed 32-bit -500.
  Data[41] = 65286; // Signed 16-bit -250.
  Data[47] = 2200;
  Data[54] = 65528; // Signed 16-bit -8.
  Data[68] = 1235;
  Data[69] = 1;
  Data[103] = 65;
  return { sn: 'TEST123456', type: 14, Data };
}

test('startup waits for group setup and uses firmware-assigned component IDs', () => {
  const host = start();
  assert.equal(host.requests().length, 0);
  assert.equal(host.timers.length, 0);
  const group = host.calls[0].params;
  assert.equal(group.id, host.handles.inv.getConfig().id);
  assert.deepEqual(Array.from(group.value), [
    'number:201', 'number:204', 'number:207', 'number:210', 'number:213',
    'number:216', 'number:219', 'text:222', 'text:225',
  ]);
  host.finishGroup();
  assert.equal(host.timers[0].period, 15000);
  assert.equal(host.timers[0].repeat, true);
  const request = host.requests()[0];
  assert.equal(request.params.url, 'http://198.51.100.10/');
  assert.equal(request.params.body, 'optType=ReadRealTimeData&pwd=TEST123456');
  assert.equal(request.params.timeout, 10);
});

test('known response decodes PV, signed powers, SOC, energy, temperature and mode', () => {
  const host = start();
  host.finishGroup();
  host.reply(snapshot());
  const actual = Object.fromEntries(
    ['pv', 'grid', 'load', 'bat', 'soc', 'totk', 'temp', 'mode'].map(role => [
      role, host.handles[role].getValue(),
    ])
  );
  assert.deepEqual(actual, {
    pv: 3100, grid: -500, load: 2200, bat: -250, soc: 65,
    totk: 6677.1, temp: -8, mode: 'Normal',
  });
  assert.ok(!host.logs.join('\n').includes('TEST123456'));
});

test('an undefined RPC error result marks stale and the next poll recovers', () => {
  const host = start();
  host.finishGroup();
  host.reply(snapshot());
  host.timers[0].callback();
  host.reply(null, -104, 200, 1);
  assert.equal(host.handles.mode.getValue(), 'Offline (stale)');
  assert.equal(host.handles.pv.getValue(), 3100);
  host.timers[0].callback();
  host.reply(snapshot(), 0, 200, 2);
  assert.equal(host.handles.mode.getValue(), 'Normal');
});

test('non-200 and malformed JSON responses are contained', () => {
  const host = start();
  host.finishGroup();
  host.reply({}, 0, 503);
  assert.equal(host.handles.mode.getValue(), 'Offline (stale)');
  host.timers[0].callback();
  const request = host.requests()[1];
  request.callback({ code: 200, body: '<html>bad gateway</html>' }, 0, '', request.userdata);
  assert.equal(host.handles.mode.getValue(), 'Invalid JSON (stale)');
});

test('null, missing, truncated and malformed data cannot publish a snapshot', () => {
  const invalidWord = snapshot();
  invalidWord.Data[34] = '65036';
  const missingWord = snapshot();
  missingWord.Data[103] = null;
  const cases = [null, { code: 1, message: 'failed' }, { Data: null },
    { type: 14, Data: Array(100).fill(0) }, invalidWord, missingWord];
  for (const body of cases) {
    const host = start();
    host.finishGroup();
    host.reply(body);
    assert.equal(host.handles.mode.getValue(), 'Invalid data (stale)');
    assert.equal(host.handles.pv.getValue(), null);
  }
});

test('unsupported inverter types and out-of-range snapshots retain all previous values', () => {
  const host = start();
  host.finishGroup();
  host.reply(snapshot());
  const unsupported = snapshot();
  unsupported.type = 5;
  host.timers[0].callback();
  host.reply(unsupported, 0, 200, 1);
  assert.equal(host.handles.mode.getValue(), 'Unsupported type (stale)');
  const outOfRange = snapshot();
  outOfRange.Data[14] = 1000;
  outOfRange.Data[103] = 101;
  host.timers[0].callback();
  host.reply(outOfRange, 0, 200, 2);
  assert.equal(host.handles.mode.getValue(), 'Out of range (stale)');
  assert.equal(host.handles.pv.getValue(), 3100);
  assert.equal(host.handles.soc.getValue(), 65);
});

test('timer and serial changes never overlap requests or publish an old response', () => {
  const host = start();
  host.finishGroup();
  host.timers[0].callback();
  host.handles.sn.change('SECOND1234');
  host.handles.sn.change('TEST123456'); // Even A -> B -> A invalidates the old read.
  assert.equal(host.requests().length, 1);
  host.reply(snapshot());
  assert.equal(host.handles.pv.getValue(), null);
  assert.equal(host.requests().length, 2);
  host.reply(snapshot(), 0, 200, 1);
  assert.equal(host.handles.mode.getValue(), 'Normal');
});

test('clearing the serial during a request discards that response without another HTTP call', () => {
  const host = start();
  host.finishGroup();
  host.handles.sn.change('');
  host.reply(snapshot());
  assert.equal(host.requests().length, 1);
  assert.equal(host.handles.pv.getValue(), null);
  assert.equal(host.handles.mode.getValue(), 'Set dongle SN');
});

test('missing components and group failures prevent polling', () => {
  for (const role of ['pv', 'sn', 'inv']) {
    const host = start({ missingRole: role });
    assert.equal(host.calls.length, 0);
    assert.equal(host.timers.length, 0);
  }
  const host = start();
  host.finishGroup(-104);
  assert.equal(host.requests().length, 0);
  assert.equal(host.timers.length, 0);
  assert.equal(host.handles.mode.getValue(), 'Group setup failed');
});

test('placeholder address, missing serial and form injection never issue HTTP requests', () => {
  for (const options of [{ placeholderIp: true }, { sn: '' }, { sn: 'SN&optType=Write' }]) {
    const host = start(options);
    host.finishGroup();
    assert.equal(host.requests().length, 0);
  }
});

test('a synchronous RPC exception releases the request lock for retry', () => {
  const host = start({ failRequest: true });
  host.finishGroup();
  assert.equal(host.handles.mode.getValue(), 'Request failed (stale)');
  host.timers[0].callback();
  assert.equal(host.requests().length, 1);
  host.reply(snapshot());
  assert.equal(host.handles.mode.getValue(), 'Normal');
});

test('numeric-string type and unknown operating codes are handled without changing the map', () => {
  const host = start();
  host.finishGroup();
  const body = snapshot();
  body.type = '14';
  body.Data[19] = 12;
  body.sn = 'DIFFERENT1';
  host.reply(body);
  assert.equal(host.handles.mode.getValue(), 'Code 12');
  assert.equal(host.handles.pv.getValue(), 3100);
  assert.ok(!host.logs.join('\n').includes('DIFFERENT1'));
});

test('unchanged UI configuration is not persisted again', () => {
  const host = start();
  const initialWrites = host.configWrites.length;
  assert.equal(initialWrites, 8);
  vm.runInContext('applyUi();', host.context);
  assert.equal(host.configWrites.length, initialWrites);
});
