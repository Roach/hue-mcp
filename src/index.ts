import * as dotenv from 'dotenv';
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

// Status → light state mappings for semantic status control
const STATUS_COLORS: Record<string, () => InstanceType<typeof LightState>> = {
  idle:      () => new LightState().on(true).brightness(40).ct(370).transitiontime(10),
  thinking:  () => new LightState().on(true).brightness(60).hsl(220, 80, 40).transitiontime(5),
  working:   () => new LightState().on(true).brightness(75).hsl(200, 60, 50).transitiontime(5),
  building:  () => new LightState().on(true).brightness(80).hsl(35, 90, 50).transitiontime(5),
  waiting:   () => new LightState().on(true).brightness(50).hsl(270, 70, 40).transitiontime(10),
  success:   () => new LightState().on(true).brightness(80).hsl(120, 90, 40).transitiontime(3),
  deployed:  () => new LightState().on(true).brightness(70).hsl(170, 80, 40).transitiontime(5),
  error:     () => new LightState().on(true).brightness(100).hsl(0, 100, 40).transitiontime(2),
  alert:     () => new LightState().on(true).brightness(100).hsl(0, 100, 50).alert('lselect'),
  off:       () => new LightState().off(),
};

// Connect to bridge using env vars, or return null if not configured
async function getApi() {
  const ip = process.env.HUE_BRIDGE_IP;
  const username = process.env.HUE_USERNAME;
  if (!ip || !username) {
    throw new Error('HUE_BRIDGE_IP and HUE_USERNAME must be set. Use discover_bridge and create_user first.');
  }
  return hueApi.createLocal(ip).connect(username);
}

// Tool definitions
const TOOLS: Tool[] = [
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
    description: 'List all lights registered on the bridge with their current state (on/off, brightness, color mode).',
    inputSchema: { type: 'object', properties: {} },
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
    name: 'set_status',
    description: 'Set lights to a semantic status color. Great for reflecting agent/project state. Statuses: idle (warm white), thinking (blue), working (bright blue), building (amber), waiting (purple), success (green), deployed (teal/cyan), error (red), alert (red flash), off.',
    inputSchema: {
      type: 'object',
      required: ['status'],
      properties: {
        status: {
          type: 'string',
          enum: ['idle', 'thinking', 'working', 'building', 'waiting', 'success', 'deployed', 'error', 'alert', 'off'],
          description: 'Semantic status to display',
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
        const lights = await api.lights.getAll();
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
