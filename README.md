# hue-mcp

A Philips Hue MCP server that lets Claude control your lights to reflect agent and project statuses in real time.

## Prerequisites

- Node.js 18 or later
- A Philips Hue bridge connected to your local network
- Hue lights paired to the bridge

## Install & Build

```bash
npm install && npm run build
```

## Setup

### 1. Discover your bridge IP

In Claude, call the `discover_bridge` tool. It will return a list of bridges found on your network, including their IP addresses.

### 2. Register a user (API key)

1. Press the physical **link button** on top of your Hue bridge.
2. Within 30 seconds, call the `create_user` tool with the bridge IP:
   ```
   create_user({ bridge_ip: "192.168.1.x" })
   ```
3. Copy the returned `username` value — this is your API key.

### 3. Configure environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

```
HUE_BRIDGE_IP=192.168.1.x
HUE_USERNAME=your-username-hash-here
HUE_DEFAULT_GROUP=0
```

`HUE_DEFAULT_GROUP=0` targets all lights. Use `get_groups` to find specific room/group IDs.

## Claude Code Configuration

Add the following to `~/.claude/settings.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "hue": {
      "command": "node",
      "args": ["/path/to/hue-mcp/dist/index.js"],
      "env": {
        "HUE_BRIDGE_IP": "your-bridge-ip",
        "HUE_USERNAME": "your-username",
        "HUE_DEFAULT_GROUP": "0"
      }
    }
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `discover_bridge` | Find Hue bridges on the local network |
| `create_user` | Register a new API user on the bridge |
| `get_lights` | List all lights and their current state |
| `get_groups` | List all groups and rooms |
| `get_scenes` | List all saved scenes |
| `set_light` | Control a single light (on/off, brightness, color) |
| `set_group` | Control all lights in a group simultaneously |
| `activate_scene` | Activate a saved scene by ID |
| `set_status` | Set lights to a semantic status color |

## Status Color Reference

`set_status` maps named statuses to specific light states, making it easy to signal what an agent or build pipeline is doing at a glance.

| Status | Color | Use when |
|--------|-------|----------|
| `idle` | warm white | no active work |
| `thinking` | soft blue | Claude is reasoning |
| `working` | bright blue | active task execution |
| `building` | amber | compiling / CI running |
| `waiting` | purple | waiting for input/review |
| `success` | green | task completed |
| `deployed` | teal | deployment finished |
| `error` | red | failure / needs attention |
| `alert` | red flash | critical alert |
| `off` | off | end of session |

### Example usage

```
set_status({ status: "thinking" })
set_status({ status: "success", group_id: 3 })
set_status({ status: "error", light_id: 5 })
```

## Development

Run directly with ts-node (no build step needed):

```bash
npm run dev
```
