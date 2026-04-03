import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
dotenv.config();

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { v3 } from 'node-hue-api';

const { api: hueApi, discovery, lightStates } = v3;
const { LightState, GroupLightState } = lightStates;

// Scale brightness by HUE_MAX_BRIGHTNESS (0-100, default 60)
const maxBrightness = parseInt(process.env.HUE_MAX_BRIGHTNESS ?? '60', 10) / 100;
const bri = (pct: number) => Math.max(1, Math.round(pct * maxBrightness));

// Status → light state mappings for semantic status control
const STATUS_COLORS: Record<string, () => InstanceType<typeof LightState>> = {
  idle:      () => new LightState().on(true).brightness(bri(40)).ct(370).transitiontime(10),
  thinking:  () => new LightState().on(true).brightness(bri(60)).hsl(220, 80, 40).transitiontime(5),
  working:   () => new LightState().on(true).brightness(bri(75)).hsl(200, 60, 50).transitiontime(5),
  building:  () => new LightState().on(true).brightness(bri(80)).hsl(35, 90, 50).transitiontime(5),
  waiting:   () => new LightState().on(true).brightness(bri(50)).hsl(270, 70, 40).transitiontime(10),
  success:   () => new LightState().on(true).brightness(bri(80)).hsl(120, 90, 40).transitiontime(3),
  deployed:  () => new LightState().on(true).brightness(bri(70)).hsl(170, 80, 40).transitiontime(5),
  error:     () => new LightState().on(true).brightness(bri(100)).hsl(0, 100, 40).transitiontime(2),
  alert:     () => new LightState().on(true).brightness(bri(100)).hsl(0, 100, 50).alert('lselect'),
  pulse_once: () => new LightState().on(true).alert('select'),
  off:       () => new LightState().off(),
};

// Connect to bridge using env vars, or return null if not configured
async function getApi() {
  const ip = process.env.HUE_BRIDGE_IP;
  const username = process.env.HUE_USERNAME;
  if (!ip || !username) {
    throw new Error(
      'Bridge not configured. Call setup() to get started, or set HUE_BRIDGE_IP and HUE_USERNAME in your environment.'
    );
  }
  return hueApi.createLocal(ip).connect(username);
}

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: 'setup',
    description: 'Smart onboarding tool. Checks configuration state, auto-discovers the bridge if needed, lists lights and zones for selection, and returns the exact next step required. Always call this first if you are unsure whether the bridge is configured.',
    inputSchema: {
      type: 'object',
      properties: {
        default_group: {
          type: 'number',
          description: 'Set the default zone/room group ID for status colors. Pass 0 to use all lights. Call setup() first (without this param) to see available groups.',
        },
        hook_light_id: {
          type: 'number',
          description: 'Light ID to animate during Claude Code sessions (thinking/working/prompt states). Call setup() first to see available lights and the suggested default.',
        },
      },
    },
  },
  {
    name: 'discover_bridge',
    description: 'Discover Philips Hue bridges on the local network. Returns IP addresses to use for setup.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_user',
    description: 'Register a new user on the Hue bridge. The physical link button on the bridge must be pressed within 30 seconds before calling this. Returns the username (API key) to save in HUE_USERNAME env var.',
    inputSchema: {
      type: 'object',
      required: ['bridge_ip'],
      properties: {
        bridge_ip: { type: 'string', description: 'IP address of the Hue bridge' },
      },
    },
  },
  {
    name: 'get_lights',
    description: 'List lights on the bridge with their current state. Supports optional filters to narrow results.',
    inputSchema: {
      type: 'object',
      properties: {
        room:       { type: 'string',  description: 'Filter by room or zone name (case-insensitive).' },
        on:         { type: 'boolean', description: 'Filter by on/off state.' },
        color_only: { type: 'boolean', description: 'If true, only return lights that support full color (excludes white-only bulbs).' },
      },
    },
  },
  {
    name: 'get_groups',
    description: 'List all groups and rooms on the bridge.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_scenes',
    description: 'List all saved scenes on the bridge.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_light',
    description: 'Control an individual light. Set on/off, brightness (0–100%), color temperature, or RGB color.',
    inputSchema: {
      type: 'object',
      required: ['light_id'],
      properties: {
        light_id: { type: 'number', description: 'Light ID from get_lights' },
        on: { type: 'boolean' },
        brightness: { type: 'number', description: '0–100 percent' },
        color_temp: { type: 'number', description: 'Color temperature: 153 (cool white) to 500 (warm white)' },
        rgb: {
          type: 'object',
          properties: {
            r: { type: 'number' }, g: { type: 'number' }, b: { type: 'number' },
          },
          description: 'RGB color (each 0–255)',
        },
        hsl: {
          type: 'object',
          properties: {
            h: { type: 'number', description: '0–359' },
            s: { type: 'number', description: '0–100' },
            l: { type: 'number', description: '0–100' },
          },
        },
        alert: { type: 'string', enum: ['none', 'select', 'lselect'], description: 'Flash: select=single, lselect=15s cycle' },
        transition_ms: { type: 'number', description: 'Transition time in milliseconds' },
      },
    },
  },
  {
    name: 'set_group',
    description: 'Control all lights in a group/room simultaneously.',
    inputSchema: {
      type: 'object',
      required: ['group_id'],
      properties: {
        group_id: { type: 'number', description: 'Group ID (0 = all lights). Use get_groups to list.' },
        on: { type: 'boolean' },
        brightness: { type: 'number', description: '0–100 percent' },
        color_temp: { type: 'number', description: '153 (cool) to 500 (warm)' },
        rgb: {
          type: 'object',
          properties: {
            r: { type: 'number' }, g: { type: 'number' }, b: { type: 'number' },
          },
        },
        hsl: {
          type: 'object',
          properties: {
            h: { type: 'number', description: '0–359' },
            s: { type: 'number', description: '0–100' },
            l: { type: 'number', description: '0–100' },
          },
        },
        alert: { type: 'string', enum: ['none', 'select', 'lselect'] },
        transition_ms: { type: 'number' },
      },
    },
  },
  {
    name: 'activate_scene',
    description: 'Activate a saved Hue scene by ID.',
    inputSchema: {
      type: 'object',
      required: ['scene_id', 'group_id'],
      properties: {
        scene_id: { type: 'string', description: 'Scene ID from get_scenes' },
        group_id: { type: 'number', description: 'Group ID the scene belongs to' },
      },
    },
  },
  {
    name: 'create_scene',
    description: 'Snapshot the current state of a group of lights as a named scene. The scene can be recalled later with activate_scene.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Name for the new scene' },
        group_id: { type: 'number', description: 'Capture lights from this group/room. Defaults to HUE_DEFAULT_GROUP.' },
        light_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Capture specific lights by ID instead of a group.',
        },
      },
    },
  },
  {
    name: 'get_sensors',
    description: 'List all sensors on the bridge — motion detectors, temperature sensors, light level sensors, buttons, and remotes.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_effect',
    description: 'Apply a native Hue v2 animated effect to one or more lights. Effects run on the light itself with no ongoing API calls. Use "no_effect" to clear.',
    inputSchema: {
      type: 'object',
      required: ['effect'],
      properties: {
        effect: {
          type: 'string',
          enum: ['candle', 'fire', 'prism', 'sparkle', 'opal', 'glisten', 'cosmos', 'no_effect'],
          description: 'Effect to apply. Not all lights support all effects — unsupported ones are silently skipped.',
        },
        light_id:  { type: 'number', description: 'Apply to a single light.' },
        group_id:  { type: 'number', description: 'Apply to all lights in a group. Use get_groups to list.' },
      },
    },
  },
  {
    name: 'get_dynamic_scenes',
    description: 'List all dynamic/animated smart scenes from the Hue v2 API — includes scenes like Candle, Fireplace, Colorloop, etc. Returns scene IDs to use with activate_dynamic_scene.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'activate_dynamic_scene',
    description: 'Activate a Hue smart scene with full animation (candle flicker, fireplace, etc.). Use get_dynamic_scenes to find scene IDs.',
    inputSchema: {
      type: 'object',
      required: ['scene_id'],
      properties: {
        scene_id: { type: 'string', description: 'Smart scene ID (UUID) from get_dynamic_scenes' },
        speed: { type: 'number', description: 'Animation speed 0.0 (slow) to 1.0 (fast). Optional.' },
      },
    },
  },
  {
    name: 'set_status',
    description: 'Set lights to a semantic status color. Great for reflecting agent/project state. Statuses: idle (warm white), thinking (blue), working (bright blue), building (amber), waiting (purple), success (green), deployed (teal/cyan), error (red), alert (red flash), off.',
    inputSchema: {
      type: 'object',
      required: ['status'],
      properties: {
        status: {
          type: 'string',
          enum: ['idle', 'thinking', 'working', 'building', 'waiting', 'success', 'deployed', 'error', 'alert', 'pulse_once', 'off'],
          description: 'Semantic status to display. pulse_once does a single breathe cycle then returns to the previous state.',
        },
        group_id: {
          type: 'number',
          description: 'Group to apply status to. Defaults to HUE_DEFAULT_GROUP env var or 0 (all lights).',
        },
        light_id: {
          type: 'number',
          description: 'Apply to a single light instead of a group.',
        },
      },
    },
  },
];

// Build a LightState from common params
function buildLightState(params: {
  on?: boolean;
  brightness?: number;
  color_temp?: number;
  rgb?: { r: number; g: number; b: number };
  hsl?: { h: number; s: number; l: number };
  alert?: string;
  transition_ms?: number;
}): InstanceType<typeof LightState> {
  const state = new LightState();
  if (params.on !== undefined) state.on(params.on);
  if (params.brightness !== undefined) state.brightness(params.brightness);
  if (params.color_temp !== undefined) state.ct(params.color_temp);
  if (params.rgb) state.rgb(params.rgb.r, params.rgb.g, params.rgb.b);
  if (params.hsl) state.hsl(params.hsl.h, params.hsl.s, params.hsl.l);
  if (params.alert) state.alert(params.alert);
  if (params.transition_ms !== undefined) state.transitiontime(params.transition_ms / 100);
  return state;
}

// Hue v2 (CLIP API) helpers — smart scenes, dynamic palettes
const v2Agent = new https.Agent({ rejectUnauthorized: false });

function v2Get(resourcePath: string): Promise<any> {
  const ip = process.env.HUE_BRIDGE_IP;
  const username = process.env.HUE_USERNAME;
  if (!ip || !username) return Promise.reject(new Error('Bridge not configured'));
  return new Promise((resolve, reject) => {
    https.get({
      hostname: ip,
      path: `/clip/v2${resourcePath}`,
      headers: { 'hue-application-key': username },
      agent: v2Agent,
    } as any, res => {
      let data = '';
      res.on('data', (d: string) => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
    }).on('error', reject);
  });
}

function v2Put(resourcePath: string, body: object): Promise<any> {
  const ip = process.env.HUE_BRIDGE_IP;
  const username = process.env.HUE_USERNAME;
  if (!ip || !username) return Promise.reject(new Error('Bridge not configured'));
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: ip,
      path: `/clip/v2${resourcePath}`,
      method: 'PUT',
      headers: {
        'hue-application-key': username,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      agent: v2Agent,
    } as any, res => {
      let out = '';
      res.on('data', (d: string) => out += d);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error('Invalid JSON')); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function v1Get(resourcePath: string): Promise<any> {
  const ip = process.env.HUE_BRIDGE_IP;
  const username = process.env.HUE_USERNAME;
  if (!ip || !username) return Promise.reject(new Error('Bridge not configured'));
  return new Promise((resolve, reject) => {
    https.get({
      hostname: ip,
      path: `/api/${username}${resourcePath}`,
      agent: v2Agent,
    } as any, res => {
      let out = '';
      res.on('data', (d: string) => out += d);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error('Invalid JSON')); } });
    }).on('error', reject);
  });
}

function v1Post(resourcePath: string, body: object): Promise<any> {
  const ip = process.env.HUE_BRIDGE_IP;
  const username = process.env.HUE_USERNAME;
  if (!ip || !username) return Promise.reject(new Error('Bridge not configured'));
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: ip,
      path: `/api/${username}${resourcePath}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      agent: v2Agent,
    } as any, res => {
      let out = '';
      res.on('data', (d: string) => out += d);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error('Invalid JSON')); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function v1Put(resourcePath: string, body: object): Promise<any> {
  const ip = process.env.HUE_BRIDGE_IP;
  const username = process.env.HUE_USERNAME;
  if (!ip || !username) return Promise.reject(new Error('Bridge not configured'));
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: ip,
      path: `/api/${username}${resourcePath}`,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      agent: v2Agent,
    } as any, res => {
      let out = '';
      res.on('data', (d: string) => out += d);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error('Invalid JSON')); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Build a map of v1 integer light ID → v2 UUID (for effects API)
async function buildV1ToV2Map(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const result = await v2Get('/resource/light');
    for (const l of (result.data ?? [])) {
      const match = l.id_v1?.match(/^\/lights\/(\d+)$/);
      if (match) map.set(parseInt(match[1], 10), l.id);
    }
  } catch { /* v2 API unavailable */ }
  return map;
}

// Pick the best light for hook animations based on name heuristics
function suggestHookLight(lights: any[]): any {
  const keywords = ['desk', 'office', 'monitor', 'computer', 'claude', 'work', 'hue go'];
  for (const kw of keywords) {
    const match = lights.find((l: any) => l.name.toLowerCase().includes(kw));
    if (match) return match;
  }
  return lights[0] ?? null;
}

// Main server
const server = new Server(
  { name: 'hue-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case 'setup': {
        const ip = process.env.HUE_BRIDGE_IP;
        const username = process.env.HUE_USERNAME;
        const envPath = path.join(__dirname, '..', '.env');

        // Save configuration params (default_group and/or hook_light_id)
        if (a.default_group !== undefined || a.hook_light_id !== undefined) {
          let envContent = '';
          try { envContent = fs.readFileSync(envPath, 'utf-8'); } catch { /* no .env yet */ }

          const setParts: string[] = [];

          if (a.default_group !== undefined) {
            const groupId = a.default_group as number;
            if (envContent.includes('HUE_DEFAULT_GROUP=')) {
              envContent = envContent.replace(/HUE_DEFAULT_GROUP=.*/g, `HUE_DEFAULT_GROUP=${groupId}`);
            } else {
              envContent = envContent.trimEnd() + `\nHUE_DEFAULT_GROUP=${groupId}\n`;
            }
            process.env.HUE_DEFAULT_GROUP = String(groupId);
            setParts.push(`default zone → ${groupId === 0 ? 'all lights' : `group ${groupId}`}`);
          }

          if (a.hook_light_id !== undefined) {
            const lightId = a.hook_light_id as number;
            if (envContent.includes('HUE_HOOK_LIGHT=')) {
              envContent = envContent.replace(/HUE_HOOK_LIGHT=.*/g, `HUE_HOOK_LIGHT=${lightId}`);
            } else {
              envContent = envContent.trimEnd() + `\nHUE_HOOK_LIGHT=${lightId}\n`;
            }
            process.env.HUE_HOOK_LIGHT = String(lightId);
            setParts.push(`hook light → ${lightId}`);
          }

          fs.writeFileSync(envPath, envContent);

          let msg = `Saved: ${setParts.join(', ')}.\n\nSetup complete! Try: set_status({ status: "idle" })`;

          if (a.hook_light_id !== undefined) {
            const scriptPath = path.join(__dirname, '..', 'hue-status.js');
            const hookConfig = {
              hooks: {
                UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node ${scriptPath} thinking` }] }],
                PreToolUse: [{ hooks: [{ type: 'command', command: `node ${scriptPath} working` }] }],
                PostToolUse: [
                  { matcher: 'exit_plan_mode', hooks: [{ type: 'command', command: `node ${scriptPath} success` }] },
                  { hooks: [{ type: 'command', command: `node ${scriptPath} thinking` }] },
                ],
                Notification: [{ matcher: 'permission_prompt', hooks: [{ type: 'command', command: `node ${scriptPath} prompt` }] }],
                Stop: [{ hooks: [{ type: 'command', command: `node ${scriptPath} restore` }] }],
              },
            };
            msg += `\n\nHUE_HOOK_LIGHT saved — hue-status.js will default to light ${a.hook_light_id}.\n\nAdd to your project's .claude/settings.json:\n\n${JSON.stringify(hookConfig, null, 2)}`;
          }

          return { content: [{ type: 'text', text: msg }] };
        }

        // Already fully configured — verify connectivity
        if (ip && username) {
          try {
            const api = await hueApi.createLocal(ip).connect(username);
            const [lights, groups] = await Promise.all([
              api.lights.getAll(),
              api.groups.getAll(),
            ]);

            const defaultGroup = parseInt(process.env.HUE_DEFAULT_GROUP ?? '0', 10);
            const hookLightId = process.env.HUE_HOOK_LIGHT ? parseInt(process.env.HUE_HOOK_LIGHT, 10) : null;
            const zones = (groups as any[]).filter(g => ['Room', 'Zone', 'LightGroup'].includes(g.type));
            const zoneList = zones.map(g => `  ${g.id}: ${g.name} (${g.type}, ${(g.lights ?? []).length} lights)`).join('\n');
            const suggested = suggestHookLight(lights as any[]);
            const lightList = (lights as any[]).map(l =>
              `  ${l.id}: ${l.name} (${l.type})${suggested && l.id === suggested.id ? ' ← suggested for hooks' : ''}`
            ).join('\n');

            const needsGroup = defaultGroup === 0;
            const needsHookLight = hookLightId === null;
            const params: string[] = [];
            if (needsGroup) params.push('default_group: <zone id or 0 for all>');
            if (needsHookLight && suggested) params.push(`hook_light_id: ${suggested.id}`);

            if (needsGroup || needsHookLight) {
              return {
                content: [{
                  type: 'text',
                  text: `Connected to bridge at ${ip}. ${(lights as any[]).length} lights found.\n\nAvailable lights:\n${lightList}\n\nAvailable zones/rooms:\n${zoneList}\n\nCall setup({ ${params.join(', ')} }) to finish setup.`,
                }],
              };
            }

            const selected = zones.find((g: any) => g.id === defaultGroup);
            const hookLight = (lights as any[]).find(l => l.id === hookLightId);
            return {
              content: [{
                type: 'text',
                text: `Connected and fully configured.\nBridge: ${ip}\nLights: ${(lights as any[]).length}\nDefault zone: ${defaultGroup}${selected ? ` — ${selected.name}` : ''}\nHook light: ${hookLightId}${hookLight ? ` — ${hookLight.name}` : ''}\n\nYou're all set — try set_status({ status: "idle" }) or get_lights.`,
              }],
            };
          } catch {
            return {
              content: [{
                type: 'text',
                text: `HUE_BRIDGE_IP and HUE_USERNAME are set, but the bridge at ${ip} is unreachable or the credentials are invalid.\n\nOptions:\n1. Check that the bridge is online and reachable at ${ip}\n2. Re-run setup after confirming the IP, or call create_user({ bridge_ip: "${ip}" }) after pressing the link button to get a fresh username.`,
              }],
            };
          }
        }

        // Have IP but no username
        if (ip && !username) {
          return {
            content: [{
              type: 'text',
              text: `Bridge IP is configured (${ip}) but no username is set.\n\nNext step:\n1. Press the physical link button on the top of your Hue bridge.\n2. Within 30 seconds, call: create_user({ bridge_ip: "${ip}" })\n3. Set the returned username as HUE_USERNAME in your environment.`,
            }],
          };
        }

        // Nothing configured — auto-discover
        const results = await discovery.nupnpSearch();
        if (results && results.length > 0) {
          const bridge = results[0] as any;
          const foundIp = bridge.ipaddress;
          const others = results.slice(1).map((b: any) => b.ipaddress);
          const othersNote = others.length > 0 ? `\nOther bridges found: ${others.join(', ')}` : '';
          return {
            content: [{
              type: 'text',
              text: `Bridge discovered at ${foundIp}.${othersNote}\n\nNext steps:\n1. Press the physical link button on the top of your Hue bridge.\n2. Within 30 seconds, call: create_user({ bridge_ip: "${foundIp}" })\n3. Set the returned values in your environment:\n   HUE_BRIDGE_IP=${foundIp}\n   HUE_USERNAME=<returned username>`,
            }],
          };
        }

        // Nothing found
        return {
          content: [{
            type: 'text',
            text: `No Hue bridges found on the network via auto-discovery.\n\nTroubleshooting:\n- Make sure the bridge is powered on and connected via ethernet\n- Confirm this machine is on the same network\n\nIf you know the bridge IP, call: create_user({ bridge_ip: "x.x.x.x" }) after pressing the link button.`,
          }],
        };
      }

      case 'discover_bridge': {
        const results = await discovery.nupnpSearch();
        if (!results || results.length === 0) {
          return { content: [{ type: 'text', text: 'No bridges found via N-UPnP. Try connecting your bridge to the network.' }] };
        }
        const bridges = results.map((b: any) => ({ id: b.id, ip: b.ipaddress, name: b.name ?? 'Hue Bridge' }));
        return { content: [{ type: 'text', text: JSON.stringify(bridges, null, 2) }] };
      }

      case 'create_user': {
        const bridgeIp = a.bridge_ip as string;
        const unauthApi = await hueApi.createLocal(bridgeIp).connect();
        const user = await unauthApi.users.createUser('hue-mcp', 'claude-mcp');
        return {
          content: [{
            type: 'text',
            text: `User created!\nUsername: ${(user as any).username}\nSet HUE_BRIDGE_IP=${bridgeIp} and HUE_USERNAME=${(user as any).username} in your .env file.`,
          }],
        };
      }

      case 'get_lights': {
        const api = await getApi();
        let lights = await api.lights.getAll() as any[];

        if (a.room) {
          const groups = await api.groups.getAll() as any[];
          const room = groups.find(g => g.name.toLowerCase() === (a.room as string).toLowerCase());
          if (room) {
            const ids = new Set((room.lights ?? []).map(String));
            lights = lights.filter(l => ids.has(String(l.id)));
          }
        }
        if (a.on !== undefined) {
          lights = lights.filter(l => l.state.on === a.on);
        }
        if (a.color_only) {
          lights = lights.filter(l => ['Extended color light', 'Color light'].includes(l.type));
        }

        const summary = lights.map((l: any) => ({
          id: l.id,
          name: l.name,
          type: l.type,
          on: l.state.on,
          brightness: l.state.bri,
          reachable: l.state.reachable,
          colorMode: l.state.colormode,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
      }

      case 'get_groups': {
        const api = await getApi();
        const groups = await api.groups.getAll();
        const summary = groups.map((g: any) => ({
          id: g.id,
          name: g.name,
          type: g.type,
          lights: g.lights,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
      }

      case 'get_sensors': {
        const sensors = await v1Get('/sensors');
        const TYPE_LABEL: Record<string, string> = {
          ZLLPresence:       'motion',
          ZLLTemperature:    'temperature',
          ZLLLightLevel:     'light_level',
          ZLLSwitch:         'dimmer_switch',
          ZGPSwitch:         'tap_switch',
          ZLLRelativeRotary: 'rotary',
        };
        const result = Object.entries(sensors)
          .filter(([, s]: [string, any]) => TYPE_LABEL[s.type])
          .map(([id, s]: [string, any]) => ({
            id: parseInt(id, 10),
            name: s.name,
            type: TYPE_LABEL[s.type],
            state: s.state,
            reachable: s.config?.reachable ?? null,
          }));
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'set_effect': {
        const effect = a.effect as string;
        const v1ToV2 = await buildV1ToV2Map();

        let v1Ids: number[] = [];
        if (a.light_id !== undefined) {
          v1Ids = [a.light_id as number];
        } else {
          const api = await getApi();
          const groupId = a.group_id !== undefined
            ? (a.group_id as number)
            : parseInt(process.env.HUE_DEFAULT_GROUP ?? '0', 10);
          if (groupId === 0) {
            const lights = await api.lights.getAll() as any[];
            v1Ids = lights.map(l => l.id);
          } else {
            const group = await api.groups.getGroup(groupId) as any;
            v1Ids = (group.lights ?? []).map(Number);
          }
        }

        const results: string[] = [];
        for (const v1Id of v1Ids) {
          const v2Id = v1ToV2.get(v1Id);
          if (!v2Id) { results.push(`light ${v1Id}: no v2 ID found, skipped`); continue; }
          const res = await v2Put(`/resource/light/${v2Id}`, { effects: { effect } });
          if (res.errors?.length) {
            results.push(`light ${v1Id}: ${res.errors[0]?.description ?? 'error'}`);
          } else {
            results.push(`light ${v1Id}: ${effect}`);
          }
        }
        return { content: [{ type: 'text', text: results.join('\n') }] };
      }

      case 'get_scenes': {
        const api = await getApi();
        const scenes = await api.scenes.getAll();
        const summary = scenes.map((s: any) => ({
          id: s.id,
          name: s.name,
          group: s.group,
          lights: s.lights,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
      }

      case 'set_light': {
        const api = await getApi();
        const lightId = a.light_id as number;
        const state = buildLightState(a as any);
        await api.lights.setLightState(lightId, state);
        return { content: [{ type: 'text', text: `Light ${lightId} updated.` }] };
      }

      case 'set_group': {
        const api = await getApi();
        const groupId = a.group_id as number;
        const state = buildLightState(a as any);
        await api.groups.setGroupState(groupId, state);
        return { content: [{ type: 'text', text: `Group ${groupId} updated.` }] };
      }

      case 'activate_scene': {
        const api = await getApi();
        const sceneId = a.scene_id as string;
        const groupId = a.group_id as number;
        const state = new GroupLightState().scene(sceneId);
        await api.groups.setGroupState(groupId, state);
        return { content: [{ type: 'text', text: `Scene ${sceneId} activated on group ${groupId}.` }] };
      }

      case 'create_scene': {
        const api = await getApi();
        const name = a.name as string;

        // Resolve which light IDs to include
        let lightIds: string[];
        if (Array.isArray(a.light_ids) && (a.light_ids as number[]).length > 0) {
          lightIds = (a.light_ids as number[]).map(String);
        } else {
          const groupId = a.group_id !== undefined
            ? (a.group_id as number)
            : parseInt(process.env.HUE_DEFAULT_GROUP ?? '0', 10);
          if (groupId === 0) {
            const lights = await api.lights.getAll();
            lightIds = (lights as any[]).map(l => String(l.id));
          } else {
            const group = await api.groups.getGroup(groupId);
            lightIds = (group as any).lights ?? [];
          }
        }

        // Create the scene, then capture current light states
        const createResp = await v1Post('/scenes', { name, lights: lightIds, recycle: false });
        const sceneId = (createResp as any[])[0]?.success?.id;
        if (!sceneId) {
          return { content: [{ type: 'text', text: `Failed to create scene: ${JSON.stringify(createResp)}` }] };
        }
        await v1Put(`/scenes/${sceneId}`, { storelightstate: true });

        return { content: [{ type: 'text', text: `Scene "${name}" created (ID: ${sceneId}) with ${lightIds.length} lights. Activate with: activate_scene({ scene_id: "${sceneId}", group_id: <group> })` }] };
      }

      case 'get_dynamic_scenes': {
        const result = await v2Get('/resource/smart_scene');
        if (result.errors?.length) {
          return { content: [{ type: 'text', text: `v2 API error: ${JSON.stringify(result.errors)}` }] };
        }
        const scenes = (result.data ?? []).map((s: any) => ({
          id: s.id,
          name: s.metadata?.name ?? 'Unknown',
          group_id: s.group?.rid,
          group_type: s.group?.rtype,
          speed: s.speed,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(scenes, null, 2) }] };
      }

      case 'activate_dynamic_scene': {
        const sceneId = a.scene_id as string;
        const body: Record<string, any> = { recall: { action: 'activate' } };
        if (a.speed !== undefined) body.speed = a.speed;
        const result = await v2Put(`/resource/smart_scene/${sceneId}`, body);
        if (result.errors?.length) {
          return { content: [{ type: 'text', text: `v2 API error: ${JSON.stringify(result.errors)}` }] };
        }
        return { content: [{ type: 'text', text: `Dynamic scene ${sceneId} activated.` }] };
      }

      case 'set_status': {
        const api = await getApi();
        const status = a.status as string;
        const stateFn = STATUS_COLORS[status];
        if (!stateFn) {
          return { content: [{ type: 'text', text: `Unknown status: ${status}` }] };
        }
        const state = stateFn();

        if (a.light_id !== undefined) {
          await api.lights.setLightState(a.light_id as number, state);
          return { content: [{ type: 'text', text: `Light ${a.light_id} set to "${status}".` }] };
        } else {
          const groupId = (a.group_id as number) ?? parseInt(process.env.HUE_DEFAULT_GROUP ?? '0', 10);
          await api.groups.setGroupState(groupId, state);
          return { content: [{ type: 'text', text: `Group ${groupId} set to "${status}".` }] };
        }
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err: any) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so it doesn't interfere with MCP stdio protocol
  process.stderr.write('Hue MCP server running\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
