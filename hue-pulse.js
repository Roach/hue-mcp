#!/usr/bin/env node
'use strict';

// Runs as a detached background process — pulses a light until killed.

const path = require('path');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const lightId  = parseInt(process.argv[2] || '6', 10);
const hue      = parseInt(process.argv[3] || '210', 10);
const maxMs    = parseInt(process.argv[4] || '0', 10);  // 0 = infinite
const HALF_CYCLE_MS = 400;

const maxBrightness = parseInt(process.env.HUE_MAX_BRIGHTNESS || '60', 10);
const MAX_BRI = Math.max(1, Math.round(maxBrightness / 100 * 254));
const MIN_BRI = Math.max(1, Math.round(MAX_BRI * 0.55));

if (maxMs > 0) setTimeout(() => {
  // Transition to idle (warm white) rather than freezing on the last pulse state
  const idleBri = Math.max(1, Math.round(MAX_BRI * 0.4));
  setState({ on: true, bri: idleBri, ct: 370, transitiontime: 5 });
  setTimeout(() => process.exit(0), 600);
}, maxMs);

const ip       = process.env.HUE_BRIDGE_IP;
const username = process.env.HUE_USERNAME;
const agent    = new https.Agent({ rejectUnauthorized: false });

function setState(body) {
  const data = JSON.stringify(body);
  const req = https.request({
    hostname: ip,
    path: `/api/${username}/lights/${lightId}/state`,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    agent,
  }, res => res.resume());
  req.on('error', () => {});
  req.write(data);
  req.end();
}

let bright = true;
const pulse = () => {
  const bri = bright ? MAX_BRI : MIN_BRI;
  bright = !bright;
  setState({ on: true, bri, hue: Math.round(hue / 360 * 65535), sat: 254, transitiontime: 3 });
};

pulse();
setInterval(pulse, HALF_CYCLE_MS);
