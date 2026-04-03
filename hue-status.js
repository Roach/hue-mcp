#!/usr/bin/env node
'use strict';

const path   = require('path');
const fs     = require('fs');
const https  = require('https');
const { spawn } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const ip       = process.env.HUE_BRIDGE_IP;
const username = process.env.HUE_USERNAME;
const agent    = new https.Agent({ rejectUnauthorized: false });

const maxBrightness = parseInt(process.env.HUE_MAX_BRIGHTNESS || '60', 10);
const scaleBri = bri => Math.max(1, Math.round(bri * maxBrightness / 100));

const STATUS_STATES = {
  idle:     { on: true,  bri: scaleBri(101), ct: 370 },
  success:  { on: true,  bri: scaleBri(200), hue: 21845, sat: 200 },
  deployed: { on: true,  bri: scaleBri(178), hue: 28920, sat: 204 },
  building: { on: true,  bri: scaleBri(200), hue: 5957,  sat: 229 },
  waiting:  { on: true,  bri: scaleBri(127), hue: 48246, sat: 178 },
  error:    { on: true,  bri: scaleBri(254), hue: 0,     sat: 254 },
  alert:     { on: true,  bri: scaleBri(254), hue: 0,     sat: 254, alert: 'lselect' },
  pulse_once: { on: true,  alert: 'select' },
  off:       { on: false },
};

const PULSE_HUE = { thinking: 185, working: 300, prompt: 0 }; // cyan, magenta, red

const status   = process.argv[2];
const lightId  = parseInt(process.argv[3] || process.env.HUE_HOOK_LIGHT || '6', 10);
const pidFile  = `/tmp/hue-pulse-${lightId}.pid`;
const saveFile = `/tmp/hue-saved-${lightId}.json`;

function get(cb) {
  https.get({ hostname: ip, path: `/api/${username}/lights/${lightId}`, agent }, res => {
    let data = '';
    res.on('data', d => data += d);
    res.on('end', () => {
      try { cb(JSON.parse(data)); } catch { cb(null); }
    });
  }).on('error', () => cb(null));
}

function put(state) {
  const body = JSON.stringify({ ...state, transitiontime: 5 });
  const req = https.request({
    hostname: ip,
    path: `/api/${username}/lights/${lightId}/state`,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    agent,
  }, res => res.resume());
  req.on('error', () => {});
  req.write(body);
  req.end();
}

function killPulse() {
  // Kill by pidFile first, then sweep for any orphaned processes
  try { process.kill(parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10), 'SIGTERM'); } catch {}
  try { fs.unlinkSync(pidFile); } catch {}
  require('child_process').execSync(`pkill -f "hue-pulse.js ${lightId}" 2>/dev/null; true`, { shell: true });
}

function spawnPulse(hueDeg, maxMs = 0) {
  const child = spawn(process.execPath, [
    path.join(__dirname, 'hue-pulse.js'), lightId, hueDeg, maxMs
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
}

killPulse();

if (status === 'thinking') {
  // Only save state at start of session (first thinking call); skip if already saved
  const alreadySaved = fs.existsSync(saveFile);
  if (alreadySaved) {
    spawnPulse(PULSE_HUE.thinking);
  } else {
    get(light => {
      if (light && light.state) {
        const s = light.state;
        const saved = { on: s.on, bri: s.bri };
        if (s.colormode === 'ct') saved.ct = s.ct;
        if (s.colormode === 'hs') { saved.hue = s.hue; saved.sat = s.sat; }
        if (s.colormode === 'xy') saved.xy = s.xy;
        try { fs.writeFileSync(saveFile, JSON.stringify(saved)); } catch {}
      }
      spawnPulse(PULSE_HUE.thinking);
    });
  }
  return;
}

if (status === 'restore') {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(saveFile, 'utf8')); } catch {}
  try { fs.unlinkSync(saveFile); } catch {} // clear for next session
  put(saved ?? STATUS_STATES.idle);
  return;
}

if (PULSE_HUE[status] !== undefined) {
  const maxMs = status === 'prompt' ? 30000 : 0;
  spawnPulse(PULSE_HUE[status], maxMs);
  process.exit(0);
}

if (!STATUS_STATES[status]) {
  console.error(`Unknown status: ${status}. Valid: ${Object.keys(STATUS_STATES).join(', ')}, thinking, working, prompt, restore`);
  process.exit(1);
}

put(STATUS_STATES[status]);
