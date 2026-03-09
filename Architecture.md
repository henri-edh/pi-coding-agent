# Architecture: Agent Forge in the Pi Agentic Engine

> How to implement `specs/agent-forge.md` within the Pi Coding Agent extension system.

---

## 1. Pi Engine Fundamentals

Before building Agent Forge, understand the Pi extension contract:

```bash
pi -e extensions/agent-forge.ts
```

Every extension exports a **default function** that receives `ExtensionAPI`. All tool/command/shortcut registrations **must happen synchronously at the top level** — not inside event handlers. Registrations inside `session_start` or any event handler are silently dropped.

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // ✅ Registrations here — synchronous, top-level
  pi.registerTool({...});
  pi.registerCommand("forge", {...});

  // ✅ Event handlers here — can reference top-level state
  pi.on("session_start", async (event, ctx) => {
    // ❌ Do NOT call pi.registerTool() here — will be silently dropped
  });
}
```

---

## 2. The Hybrid Proxy Model vs. Agent-Team

The spec mandates a **Hybrid Proxy Model** — this is the key architectural difference from existing orchestration extensions:

| Approach | Extension | Isolation | Speed | API Access |
| --- | --- | --- | --- | --- |
| **New Process** | `agent-team.ts`, `agent-chain.ts` | Full subprocess | Slow (spawn overhead) | None (stdout only) |
| **Hybrid Proxy** | `agent-forge.ts` | Same process | Instantaneous | Full `ExtensionAPI` |

Agent Forge uses `jiti` (Pi's internal TypeScript runtime) to dynamically `import()` forged `.ts` files into the **running process**. This means forged tools:

- Execute within the same Node.js/Bun context
- Have direct access to `pi: ExtensionAPI` and `ctx: ExtensionContext`
- Can call `ctx.ui.notify()`, read session state, and invoke other tools
- Require zero spawn overhead

---

## 3. File Layout

```text
extensions/
├── agent-forge.ts              ← The extension (3 core tools)
├── forge-registry.json         ← Central manifest (created at first use)
├── forge-<name>.ts             ← Generated tool source
├── forge-<name>.ts.bak         ← Previous version backup
└── forge-<name>.json           ← Tool metadata
```

### forge-registry.json Schema

```json
{
  "version": 1,
  "tools": [
    {
      "name": "sql-explorer",
      "description": "Query SQLite databases",
      "path": "extensions/forge-sql-explorer.ts",
      "metaPath": "extensions/forge-sql-explorer.json",
      "createdAt": "2026-03-09T12:00:00Z",
      "updatedAt": "2026-03-09T12:05:00Z",
      "status": "healthy"
    }
  ]
}
```

### forge-\<name\>.json Schema

```json
{
  "name": "sql-explorer",
  "description": "Query SQLite databases and return results as markdown tables",
  "parameters": {
    "type": "object",
    "properties": {
      "dbPath": { "type": "string", "description": "Path to .db file" },
      "query": { "type": "string", "description": "SQL query to run" }
    },
    "required": ["dbPath", "query"]
  }
}
```

---

## 4. Forged Tool Template

Every forged tool **must** follow this exact structure (the spec's Section 6):

```typescript
import { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export const metadata = {
  name: "custom_tool",
  description: "...",
  parameters: Type.Object({
    // parameters here
  })
};

export async function execute(params: any, pi: ExtensionAPI, ctx: any) {
  // Logic here — has full access to pi and ctx
  // Can call ctx.ui.notify(), read files, run bash, etc.
}
```

Agent Forge wraps user-provided `logic` in this template when calling `forge_tool`.

---

## 5. Core Tools Implementation

### 5.1 `forge_tool` — Generate or Update a Tool

**Parameters**:

```typescript
Type.Object({
  name: Type.String({ description: "Tool name (snake_case)" }),
  description: Type.String({ description: "What the tool does" }),
  parametersSchema: Type.String({ description: "TypeBox schema as TypeScript string" }),
  logic: Type.String({ description: "TypeScript body of the execute function" }),
})
```

**Execute Flow**:

1. Validate `name` matches `[a-z][a-z0-9_]*`
2. If `forge-<name>.ts` exists, copy to `forge-<name>.ts.bak`
3. Wrap `logic` in the mandatory tool template
4. Write `extensions/forge-<name>.ts` and `extensions/forge-<name>.json`
5. **Pre-flight Check**: Dynamically import the file via jiti
   - On success: Update `forge-registry.json`, notify user
   - On failure: Report error + full source to agent for self-healing
6. If pre-flight passes, register tool in the running process via `pi.registerTool()`

**Critical implementation note**: `pi.registerTool()` normally must be called at extension load. To support dynamically adding tools after load, you need to maintain a registry of active forged tools and proxy them through a single top-level registered tool (`use_forge_tool`). See Section 5.2.

```typescript
// Top-level: register the proxy dispatcher
pi.registerTool({
  name: "use_forge_tool",
  // ...
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const mod = await import(/* @vite-ignore */ toolPath);
    return await mod.execute(params.toolParams, pi, ctx);
  }
});
```

### 5.2 `use_forge_tool` — Execute a Forged Tool

**Parameters**:

```typescript
Type.Object({
  toolName: Type.String({ description: "Name of the forged tool to execute" }),
  toolParams: Type.Record(Type.String(), Type.Unknown(), {
    description: "Parameters to pass to the tool"
  }),
})
```

**Execute Flow**:

1. Look up `toolName` in the in-memory registry (loaded from `forge-registry.json`)
2. Resolve absolute path to `extensions/forge-<toolName>.ts`
3. Dynamic import: `const mod = await import(resolvedPath)`
4. Call `await mod.execute(params.toolParams, pi, ctx)`
5. On error: catch stack trace + read source file, return both to agent

**Self-Healing Response Format** (on error):

```text
TOOL EXECUTION FAILED: sql-explorer

Error: TypeError: Cannot read property 'rows' of undefined
    at execute (extensions/forge-sql-explorer.ts:12:18)

Source Code:
\`\`\`typescript
[full source of forge-sql-explorer.ts]
\`\`\`

To fix, call forge_tool with the corrected logic.
```

### 5.3 `list_forge` — Enumerate Available Tools

**Parameters**: `Type.Object({})` (no parameters)

**Execute Flow**:

1. Read `forge-registry.json`
2. Format each tool as a markdown table row
3. Return formatted list with name, description, status, last updated

---

## 6. Dynamic Tool Loading via jiti

Pi's runtime uses jiti for JIT TypeScript compilation. The pattern for dynamic loading:

```typescript
import { createJiti } from "jiti";
import { resolve } from "path";

// Pre-flight check in forge_tool
async function preflight(toolPath: string): Promise<{ ok: boolean; error?: string }> {
  try {
    // Force fresh load (no cache)
    const jiti = createJiti(import.meta.url, { cache: false });
    await jiti.import(toolPath);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message + "\n" + e.stack };
  }
}
```

For runtime execution in `use_forge_tool`, use a cache-busted dynamic import:

```typescript
// Cache bust with timestamp to force re-evaluation on update
const cacheBuster = `?t=${Date.now()}`;
const mod = await import(resolvedAbsPath + cacheBuster);
```

---

## 7. The `before_agent_start` Hook — Registry Loading

The spec mentions `forge-registry.json` is loaded during the `before_agent_start` hook. This populates the agent's system prompt with available forged tools:

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  const registry = loadRegistry(); // reads forge-registry.json
  if (registry.tools.length === 0) return {};

  const toolList = registry.tools
    .map(t => `- \`${t.name}\`: ${t.description}`)
    .join("\n");

  return {
    systemPrompt: event.systemPrompt + `\n\n## Available Forged Tools\n${toolList}\n\nUse \`use_forge_tool\` to invoke these.`,
  };
});
```

---

## 8. Safety & Sandboxing

The spec restricts forged tools to a "Core Library" of imports. Enforce this via a **static analysis scan** before writing the file:

```typescript
const ALLOWED_IMPORTS = [
  "node:fs", "fs",
  "node:path", "path",
  "node:child_process", "child_process",
  "@sinclair/typebox",
  "@mariozechner/pi-coding-agent",
];

function validateImports(source: string): string[] {
  const violations: string[] = [];
  const importPattern = /^import\s+.*from\s+['"]([^'"]+)['"]/gm;
  let match;
  while ((match = importPattern.exec(source)) !== null) {
    const pkg = match[1];
    if (!ALLOWED_IMPORTS.some(allowed => pkg === allowed || pkg.startsWith(allowed + "/"))) {
      violations.push(pkg);
    }
  }
  return violations;
}
```

Return violations to the agent before writing any files.

---

## 9. UI Integration

### 9.1 Forge Widget

Register in `session_start` using `ctx.ui.setWidget()`:

```typescript
pi.on("session_start", async (event, ctx) => {
  ctx.ui.setWidget("forge", (_tui, theme) => {
    const registry = loadRegistry();
    const healthy = registry.tools.filter(t => t.status === "healthy").length;
    const broken = registry.tools.filter(t => t.status === "broken").length;
    const lastAction = getLastAction(); // in-memory state

    return {
      render(width: number): string[] {
        const header = theme.fg("accent", " ⚒  Agent Forge");
        const count = theme.fg("success", `${healthy} tools`);
        const brokenStr = broken > 0 ? theme.fg("error", ` ${broken} broken`) : "";
        const last = theme.fg("dim", ` Last: ${lastAction}`);
        return [header + "  " + count + brokenStr + last];
      },
      invalidate() {},
    };
  });
});
```

### 9.2 Status Bar — Forge Tier

```typescript
function getTier(toolCount: number): string {
  if (toolCount === 0) return "Tier 0: Unforged";
  if (toolCount < 3)  return "Tier 1: Apprentice";
  if (toolCount < 7)  return "Tier 2: Journeyman";
  if (toolCount < 15) return "Tier 3: Artisan";
  return "Tier 4: Master Forge";
}

// Update status bar after each forge operation
ctx.ui.setStatus("forge-tier", getTier(registry.tools.length));
```

### 9.3 Notify on Key Events

```typescript
ctx.ui.notify(`Forged '${name}' successfully`, "success");
ctx.ui.notify(`Pre-flight failed for '${name}' — check errors`, "error");
ctx.ui.notify(`Executing '${name}'...`, "info");
```

---

## 10. Tool Execution Architecture (Full Picture)

```text
Agent calls use_forge_tool(toolName="sql-explorer", toolParams={...})
         │
         ▼
use_forge_tool.execute()
  1. Load registry → find "sql-explorer"
  2. Resolve path: extensions/forge-sql-explorer.ts
  3. dynamic import(path + "?t=" + Date.now())
         │
         ▼
  forge-sql-explorer.ts (same process, same Pi runtime)
    execute(params, pi, ctx)
      ├── can call ctx.ui.notify()
      ├── can call pi.exec("sqlite3 ...")
      ├── can read files via Node.js fs
      └── returns { content: [...], details: {...} }
         │
         ▼
  On success → return result to agent
  On error   → return stack trace + source code
                "Call forge_tool to fix me"
```

---

## 11. Integration with Agent-Team (spec Section 7)

Agent Forge composes naturally with `agent-team`. An "Engineer" agent in a team can forge tools that a "Builder" agent later uses:

**`.pi/agents/teams.yaml`**:

```yaml
forge-team:
  description: "Engineer builds tools, Builder uses them"
  agents:
    - engineer  # Has forge_tool and use_forge_tool
    - builder   # Has use_forge_tool only
    - analyst   # Has use_forge_tool only
```

**`.pi/agents/engineer.md`**:

```markdown
---
name: engineer
description: Specialist who builds new tools with Agent Forge
tools: forge_tool, use_forge_tool, list_forge, read, write, bash
---
You are a meta-programmer. When the team needs a new capability, you forge it.
Always pre-test tools before declaring them ready. Use list_forge to avoid duplicates.
```

Load both extensions together:

```bash
pi -e extensions/agent-team.ts -e extensions/agent-forge.ts
```

---

## 12. Complete Extension Skeleton

```typescript
// extensions/agent-forge.ts
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = resolve(__dirname, "forge-registry.json");
const ALLOWED_IMPORTS = ["node:fs", "fs", "node:path", "path", "node:child_process",
  "child_process", "@sinclair/typebox", "@mariozechner/pi-coding-agent"];

// In-memory state
let lastAction = "None";
let registry = loadRegistry();

function loadRegistry() { /* read forge-registry.json or return empty */ }
function saveRegistry(r: any) { /* write forge-registry.json */ }
function validateImports(source: string): string[] { /* scan imports */ }
function getTier(count: number): string { /* tier label */ }

export default function (pi: ExtensionAPI) {

  // ── forge_tool ───────────────────────────────────────────────────────────
  pi.registerTool({
    name: "forge_tool",
    label: "Forge Tool",
    description: "Generate or update a forged tool in extensions/",
    parameters: Type.Object({
      name: Type.String(),
      description: Type.String(),
      parametersSchema: Type.String(),
      logic: Type.String(),
    }),
    async execute(id, params, signal, onUpdate, ctx) {
      const { name, description, parametersSchema, logic } = params;

      // Validate name
      if (!/^[a-z][a-z0-9_]*$/.test(name)) {
        return { content: [{ type: "text", text: "Error: name must be snake_case" }] };
      }

      // Validate imports in logic
      const violations = validateImports(logic);
      if (violations.length > 0) {
        return { content: [{ type: "text", text: `Disallowed imports: ${violations.join(", ")}` }] };
      }

      const tsPath = resolve(__dirname, `forge-${name}.ts`);
      const jsonPath = resolve(__dirname, `forge-${name}.json`);

      // Backup previous version
      if (existsSync(tsPath)) copyFileSync(tsPath, tsPath + ".bak");

      // Write tool source
      const source = `import { ExtensionAPI } from "@mariozechner/pi-coding-agent";\nimport { Type } from "@sinclair/typebox";\n\nexport const metadata = {\n  name: "${name}",\n  description: ${JSON.stringify(description)},\n  parameters: ${parametersSchema}\n};\n\nexport async function execute(params: any, pi: ExtensionAPI, ctx: any) {\n${logic}\n}\n`;
      writeFileSync(tsPath, source, "utf8");
      writeFileSync(jsonPath, JSON.stringify({ name, description }, null, 2), "utf8");

      // Pre-flight check
      try {
        const { createJiti } = await import("jiti");
        const jiti = createJiti(import.meta.url, { cache: false });
        await jiti.import(tsPath);
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Pre-flight FAILED:\n${e.message}\n\nSource:\n\`\`\`typescript\n${source}\n\`\`\`` }],
        };
      }

      // Update registry
      const entry = { name, description, path: `extensions/forge-${name}.ts`, status: "healthy", updatedAt: new Date().toISOString() };
      const existing = registry.tools.findIndex((t: any) => t.name === name);
      if (existing >= 0) registry.tools[existing] = entry;
      else registry.tools.push(entry);
      saveRegistry(registry);

      lastAction = `Forged '${name}'`;
      ctx.ui.notify(`Forged '${name}' successfully`, "success");
      ctx.ui.setStatus("forge-tier", getTier(registry.tools.length));

      return { content: [{ type: "text", text: `Tool '${name}' forged and verified.` }] };
    },
    renderCall(args, theme) { /* ... */ },
    renderResult(result, options, theme) { /* ... */ },
  });

  // ── use_forge_tool ───────────────────────────────────────────────────────
  pi.registerTool({
    name: "use_forge_tool",
    label: "Use Forge Tool",
    description: "Execute a previously forged tool",
    parameters: Type.Object({
      toolName: Type.String(),
      toolParams: Type.Record(Type.String(), Type.Unknown()),
    }),
    async execute(id, params, signal, onUpdate, ctx) {
      const entry = registry.tools.find((t: any) => t.name === params.toolName);
      if (!entry) return { content: [{ type: "text", text: `Unknown tool: ${params.toolName}. Use list_forge.` }] };

      const tsPath = resolve(__dirname, `forge-${params.toolName}.ts`);
      lastAction = `Executing '${params.toolName}'`;
      ctx.ui.notify(`Executing '${params.toolName}'...`, "info");

      try {
        const mod = await import(/* @vite-ignore */ tsPath + `?t=${Date.now()}`);
        const result = await mod.execute(params.toolParams, pi, ctx);
        lastAction = `Ran '${params.toolName}'`;
        return result ?? { content: [{ type: "text", text: "Done (no output returned)" }] };
      } catch (e: any) {
        const source = readFileSync(tsPath, "utf8");
        entry.status = "broken";
        saveRegistry(registry);
        return {
          content: [{
            type: "text",
            text: `TOOL FAILED: ${params.toolName}\n\n${e.message}\n${e.stack}\n\nSource:\n\`\`\`typescript\n${source}\n\`\`\`\n\nCall forge_tool to fix.`,
          }],
        };
      }
    },
    renderCall(args, theme) { /* ... */ },
    renderResult(result, options, theme) { /* ... */ },
  });

  // ── list_forge ───────────────────────────────────────────────────────────
  pi.registerTool({
    name: "list_forge",
    label: "List Forge",
    description: "List all available forged tools",
    parameters: Type.Object({}),
    async execute(id, params, signal, onUpdate, ctx) {
      registry = loadRegistry();
      if (registry.tools.length === 0) {
        return { content: [{ type: "text", text: "No tools forged yet. Use forge_tool to create one." }] };
      }
      const rows = registry.tools.map((t: any) =>
        `| \`${t.name}\` | ${t.description} | ${t.status} |`
      ).join("\n");
      return { content: [{ type: "text", text: `| Name | Description | Status |\n|---|---|---|\n${rows}` }] };
    },
    renderCall(args, theme) { /* ... */ },
    renderResult(result, options, theme) { /* ... */ },
  });

  // ── Events ───────────────────────────────────────────────────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    registry = loadRegistry();
    if (registry.tools.length === 0) return {};
    const toolList = registry.tools.map((t: any) => `- \`${t.name}\`: ${t.description}`).join("\n");
    return { systemPrompt: event.systemPrompt + `\n\n## Forged Tools Available\n${toolList}\n\nUse \`use_forge_tool\` to invoke them.` };
  });

  pi.on("session_start", async (event, ctx) => {
    ctx.ui.setTitle("π forge");
    ctx.ui.setStatus("forge-tier", getTier(registry.tools.length));
    ctx.ui.setWidget("forge", (_tui, theme) => ({
      render(width: number) {
        registry = loadRegistry();
        const healthy = registry.tools.filter((t: any) => t.status === "healthy").length;
        const broken = registry.tools.filter((t: any) => t.status === "broken").length;
        const hStr = theme.fg("success", `${healthy} tools`);
        const bStr = broken > 0 ? theme.fg("error", ` · ${broken} broken`) : "";
        const last = theme.fg("dim", ` · Last: ${lastAction}`);
        return [theme.fg("accent", " ⚒  Forge") + "  " + hStr + bStr + last];
      },
      invalidate() {},
    }));
  });
}
```

---

## 13. Running Agent Forge

```bash
# Standalone
pi -e extensions/agent-forge.ts

# With theme
pi -e extensions/theme-cycler.ts -e extensions/agent-forge.ts

# With agent-team for collaborative forging
pi -e extensions/agent-team.ts -e extensions/agent-forge.ts

# Add to justfile
forge:
    pi -e extensions/agent-forge.ts
```

---

## 14. Architecture Summary

```text
┌─────────────────────────────────────────────────────────────────────┐
│  extensions/agent-forge.ts                                          │
│                                                                     │
│  Registered Tools (top-level, sync):                                │
│  ├── forge_tool      → write .ts/.json, preflight, update registry  │
│  ├── use_forge_tool  → dynamic import .ts, execute, self-heal       │
│  └── list_forge      → read registry, format table                  │
│                                                                     │
│  Event Hooks:                                                       │
│  ├── before_agent_start → inject registry into system prompt        │
│  └── session_start      → widget, status bar, title                 │
└───────────────────────────────────────┬─────────────────────────────┘
                                        │ dynamic import (jiti, same process)
                                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│  extensions/forge-<name>.ts  (generated)                            │
│                                                                     │
│  export const metadata = { name, description, parameters }         │
│  export async function execute(params, pi: ExtensionAPI, ctx) {    │
│    // Full access to pi, ctx, Node.js builtins                      │
│    // Can: notify, read files, run bash, call other tools           │
│  }                                                                  │
└─────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│  extensions/forge-registry.json                                     │
│  { tools: [{ name, description, path, status, updatedAt }] }       │
└─────────────────────────────────────────────────────────────────────┘
```

Key invariants:

- **Three tools, one extension file** — `forge_tool`, `use_forge_tool`, `list_forge`
- **Proxy dispatch** — `use_forge_tool` is the single top-level dispatcher; dynamic imports happen inside its `execute()`
- **Same-process loading** — forged tools get `pi` and `ctx` directly, not via IPC
- **Self-healing loop** — errors return source code so the agent can immediately re-forge
- **Registry-first** — `before_agent_start` surfaces available tools in the system prompt automatically
