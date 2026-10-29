/* @meta {"vc":{"pv":{"type":"number","config":{"name":"PV power"}},"grid":{"type":"number","config":{"name":"Grid power"}},"load":{"type":"number","config":{"name":"Load power"}},"bat":{"type":"number","config":{"name":"Battery power"}},"soc":{"type":"number","config":{"name":"Battery SOC"}},"totk":{"type":"number","config":{"name":"Total energy"}},"temp":{"type":"number","config":{"name":"Heatsink temperature"}},"mode":{"type":"text","config":{"name":"Operating status"}},"sn":{"type":"text","config":{"name":"Dongle SN","persisted":true,"default_value":""}},"inv":{"type":"group","config":{"name":"SolaX X3 Hybrid G4"}}}} */
/**
 * @title SolaX X3 Hybrid G4 local HTTP integration
 * @description Local HTTP communication with SolaX X3 Hybrid G4 dongles: read type-14 telemetry and expose it through Shelly Virtual Components. Requires firmware 2.0.0+ with managed VC support.
 * @status under development
 * @link https://github.com/ALLTERCO/shelly-script-examples/blob/main/http-integrations/solax/solax-x3-hybrid-g4-local-http.shelly.js
 */

/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Georgi Germanov and contributors
 *
 * Shelly -> local HTTP POST -> SolaX dongle -> inverter telemetry.
 * Request: optType=ReadRealTimeData&pwd=<dongle serial number>.
 * Response: {sn, ver, type: 14, Data: [...], Information: [...]}.
 * This integration reads telemetry and exposes it through Virtual Components.
 * A dashboard is a natural next step built on the received data. This script
 * sends no inverter control commands.
 *
 * Requirements / setup:
 * - A Shelly device exposing scripts and Script.getVcHandle(), firmware 2.0.0+.
 * - Ten available Virtual Component slots, including the group.
 * - A reachable SolaX dongle exposing the local ReadRealTimeData endpoint.
 * - Set CONFIG.ip below, then enter the serial in the persisted Dongle SN tile.
 * - Keep the complete @meta comment first, on one line, <=1024 characters.
 *   Units and ranges are applied at startup to keep that declaration small.
 * - Group.Set resolves allocated IDs at runtime, avoiding the firmware 2.2.0
 *   requirement of @meta group members. No managed VC IDs are hard-coded.
 *
 * Roles: pv (PV power), grid (grid power), load (house load), bat (battery
 * power), soc (battery SOC), totk (total energy), temp (heatsink temperature),
 * mode (inverter / communication status), sn (dongle serial), inv (group).
 *
 * The original Data[] indexes, scales, signed conversion and operating-mode
 * table are retained from the contributor's working script. Communication
 * with the inverter was reported working on 2026-10-29; exact device/firmware
 * versions and individual power-direction checks were not recorded.
 * The zero-based Data[] map and scales are documented alongside the decoder.
 * Confirm grid/battery power direction against the specific installation.
 *
 * One HTTP request may be active at a time. Changing Dongle SN invalidates
 * the pending response and triggers a fresh read when that request finishes.
 * Failed reads retain the previous measurements; the status marks them stale.
 * Only the serial is persisted. No serial or full response is printed.
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

let CONFIG = {
  ip: '192.0.2.10', // Replace this documentation-only address with the dongle IP.
  period: 15000, // Timer.set() uses milliseconds.
  timeout: 10, // HTTP.POST timeout uses seconds.
};

let MODE = [
  'Waiting',
  'Checking',
  'Normal',
  'Fault',
  'Perm. Fault',
  'Updating',
  'EPS Check',
  'EPS Mode',
  'Self Test',
  'Idle',
  'Standby',
];

// Role, unit, step, minimum, maximum. These are display limits, not ratings.
let UI = [
  ['pv', 'W', 1, 0, 30000],
  ['grid', 'W', 1, -30000, 30000],
  ['load', 'W', 1, -30000, 30000],
  ['bat', 'W', 1, -30000, 30000],
  ['soc', '%', 1, 0, 100],
  ['totk', 'kWh', 0.1, 0, 999999],
  ['temp', '°C', 1, -40, 120],
];

let ROLES = ['pv', 'grid', 'load', 'bat', 'soc', 'totk', 'temp', 'mode', 'sn'];
let DATA_WORDS = [14, 15, 19, 34, 35, 41, 47, 54, 68, 69, 103];

// ============================================================================
// STATE AND HELPERS
// ============================================================================

let handles = {};
let groupHandle = null;
let requestInFlight = false;
let configurationVersion = 0;

function s16(value) {
  return value > 32767 ? value - 65536 : value;
}

function s32(low, high) {
  let value = low + high * 65536;
  return value > 2147483647 ? value - 4294967296 : value;
}

function r1(value) {
  return Math.floor(value * 10 + 0.5) / 10;
}

function applyUi() {
  for (let i = 0; i < UI.length; i++) {
    let row = UI[i];
    let handle = handles[row[0]];
    let config = handle.getConfig();
    let ui = config.meta && config.meta.ui;
    if (
      ui &&
      ui.view === 'label' &&
      ui.unit === row[1] &&
      ui.step === row[2] &&
      config.min === row[3] &&
      config.max === row[4]
    ) {
      continue;
    }
    // Configuration is persistent; write only when a setting differs.
    handle.setConfig({
      min: row[3],
      max: row[4],
      meta: { ui: { view: 'label', unit: row[1], step: row[2] } },
    });
  }

  let config = handles.sn.getConfig();
  if (!config.meta || !config.meta.ui || config.meta.ui.view !== 'field') {
    handles.sn.setConfig({ meta: { ui: { view: 'field' } } });
  }
}

function applyGroup() {
  let members = [];
  for (let i = 0; i < ROLES.length; i++) {
    let role = ROLES[i];
    let type = role === 'mode' || role === 'sn' ? 'text:' : 'number:';
    members[i] = type + JSON.stringify(handles[role].getConfig().id);
  }
  Shelly.call(
    'Group.Set',
    { id: groupHandle.getConfig().id, value: members },
    onGroupReady
  );
}

function isValidData(data) {
  if (!data || typeof data !== 'object' || !(data.length >= 110)) return false;
  for (let i = 0; i < DATA_WORDS.length; i++) {
    let value = data[DATA_WORDS[i]];
    if (
      typeof value !== 'number' ||
      value !== Math.floor(value) ||
      !(value >= 0 && value <= 65535)
    ) {
      return false;
    }
  }
  return true;
}

// ============================================================================
// POLLING
// ============================================================================

function onData(result, errorCode, errorMessage, request) {
  requestInFlight = false;
  if (request.version !== configurationVersion) {
    poll(); // The serial changed while this request was running.
    return;
  }
  if (errorCode !== 0 || !result || result.code !== 200) {
    handles.mode.setValue('Offline (stale)');
    print('solax: HTTP error', errorCode, result ? result.code : '-');
    return;
  }

  let response;
  try {
    response = JSON.parse(result.body);
  } catch (error) {
    handles.mode.setValue('Invalid JSON (stale)');
    return;
  }
  if (!response || !isValidData(response.Data)) {
    // Incorrect credentials can return {code, message} without Data.
    handles.mode.setValue('Invalid data (stale)');
    return;
  }
  if (response.type !== 14 && response.type !== '14') {
    handles.mode.setValue('Unsupported type (stale)');
    return;
  }
  if (response.sn !== undefined && response.sn !== request.sn) {
    print('solax: response serial differs from the configured dongle serial');
  }

  let data = response.Data;
  let values = [
    data[14] + data[15], // PV1 + PV2 power.
    s32(data[34], data[35]), // Signed grid power, low word first.
    s16(data[47]), // House load power.
    s16(data[41]), // Signed battery power.
    data[103], // Battery state of charge.
    r1(s32(data[68], data[69]) / 10), // Original total-energy decoding.
    s16(data[54]), // Heatsink temperature.
  ];

  // Validate the whole snapshot before updating any measurement tile.
  for (let i = 0; i < UI.length; i++) {
    if (values[i] < UI[i][3] || values[i] > UI[i][4]) {
      handles.mode.setValue('Out of range (stale)');
      print('solax: value outside display range for', UI[i][0]);
      return;
    }
  }
  for (let i = 0; i < UI.length; i++) {
    handles[UI[i][0]].setValue(values[i]);
  }
  handles.mode.setValue(
    data[19] < MODE.length ? MODE[data[19]] : 'Code ' + JSON.stringify(data[19])
  );
}

function poll() {
  if (requestInFlight) return;
  if (!CONFIG.ip || CONFIG.ip === '192.0.2.10') {
    handles.mode.setValue('Set dongle IP');
    return;
  }
  let sn = handles.sn.getValue();
  if (typeof sn !== 'string' || sn === '') {
    handles.mode.setValue('Set dongle SN');
    return;
  }
  // Serial numbers are alphanumeric; reject form separators and other input.
  for (let i = 0; i < sn.length; i++) {
    let c = sn.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122))) {
      handles.mode.setValue('Invalid dongle SN');
      return;
    }
  }

  requestInFlight = true;
  try {
    Shelly.call(
      'HTTP.POST',
      {
        url: 'http://' + CONFIG.ip + '/',
        body: 'optType=ReadRealTimeData&pwd=' + sn,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: CONFIG.timeout,
      },
      onData,
      { sn: sn, version: configurationVersion }
    );
  } catch (error) {
    requestInFlight = false;
    handles.mode.setValue('Request failed (stale)');
    print('solax: could not start HTTP request');
  }
}

// ============================================================================
// EVENT HANDLERS AND INITIALIZATION
// ============================================================================

function onSerialChange() {
  configurationVersion++;
  handles.mode.setValue('Serial changed (stale)');
  poll();
}

function onGroupReady(result, errorCode) {
  if (errorCode !== 0) {
    handles.mode.setValue('Group setup failed');
    print('solax: group setup error', errorCode);
    return;
  }
  handles.sn.on('change', onSerialChange);
  handles.mode.setValue('Waiting for data');
  Timer.set(CONFIG.period, true, poll);
  poll();
  print('solax: local HTTP integration started, polling every', CONFIG.period, 'ms');
}

function init() {
  if (typeof Script.getVcHandle !== 'function') {
    print('solax: firmware with managed Virtual Components is required');
    return;
  }
  for (let i = 0; i < ROLES.length; i++) {
    let role = ROLES[i];
    handles[role] = Script.getVcHandle(role);
    if (!handles[role]) {
      print('solax: missing Virtual Component', role);
      return;
    }
  }
  groupHandle = Script.getVcHandle('inv');
  if (!groupHandle) {
    print('solax: missing inverter group');
    return;
  }
  applyUi();
  applyGroup();
}

init();
