/**
 * Agent Forge — Evolutionary Tooling Extension
 *
 * Enables Pi to expand its own capabilities by dynamically generating,
 * validating, and loading new TypeScript tools on demand. Uses a Hybrid
 * Proxy Model: forged tools are imported into the same process via jiti,
 * giving them direct access to ExtensionAPI and ExtensionContext.
 *
 * Three core tools:
 *   forge_tool     — Generate or update a forged tool
 *   use_forge_tool — Execute a previously forged tool
 *   list_forge     — List all available forged tools
 *
 * File layout:
 *   extensions/forge-registry.json   Central manifest
 *   extensions/forge-<name>.ts       Generated tool source
 *   extensions/forge-<name>.json     Tool metadata
 *   extensions/forge-<name>.ts.bak   Previous version backup
 *
 * Usage: pi -e extensions/agent-forge.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { applyExtensionDefaults } from "./themeMap.ts";

// ── Constants ──────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = resolve(__dirname, "forge-registry.json");

/** Imports that forged tools are allowed to use. */
const ALLOWED_IMPORTS = [
	"node:fs",
	"fs",
	"node:path",
	"path",
	"node:child_process",
	"child_process",
	"@sinclair/typebox",
	"@mariozechner/pi-coding-agent",
];

// ── Types ──────────────────────────────────────────────────────────────────

interface ForgeEntry {
	name: string;
	description: string;
	path: string;
	status: "healthy" | "broken";
	createdAt: string;
	updatedAt: string;
}

interface ForgeRegistry {
	version: number;
	tools: ForgeEntry[];
}

// ── Module-level state ─────────────────────────────────────────────────────

let lastAction = "None";
let registry = loadRegistry();

// ── Registry helpers ───────────────────────────────────────────────────────

function loadRegistry(): ForgeRegistry {
	if (!existsSync(REGISTRY_PATH)) {
		return { version: 1, tools: [] };
	}
	try {
		return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as ForgeRegistry;
	} catch {
		return { version: 1, tools: [] };
	}
}

function saveRegistry(r: ForgeRegistry): void {
	writeFileSync(REGISTRY_PATH, JSON.stringify(r, null, 2), "utf8");
}

// ── Safety helpers ─────────────────────────────────────────────────────────

/** Scan for any imports in the logic string not on the allowlist. */
function validateImports(source: string): string[] {
	const violations: string[] = [];
	const pattern = /^import\s+.*from\s+['"]([^'"]+)['"]/gm;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(source)) !== null) {
		const pkg = match[1];
		if (!ALLOWED_IMPORTS.some((a) => pkg === a || pkg.startsWith(a + "/"))) {
			violations.push(pkg);
		}
	}
	return violations;
}

// ── UI helpers ─────────────────────────────────────────────────────────────

function getTier(count: number): string {
	if (count === 0) return "Tier 0: Unforged";
	if (count < 3) return "Tier 1: Apprentice";
	if (count < 7) return "Tier 2: Journeyman";
	if (count < 15) return "Tier 3: Artisan";
	return "Tier 4: Master Forge";
}

function buildToolSource(name: string, description: string, parametersSchema: string, logic: string): string {
	return [
		`import { ExtensionAPI } from "@mariozechner/pi-coding-agent";`,
		`import { Type } from "@sinclair/typebox";`,
		``,
		`export const metadata = {`,
		`  name: ${JSON.stringify(name)},`,
		`  description: ${JSON.stringify(description)},`,
		`  parameters: ${parametersSchema}`,
		`};`,
		``,
		`export async function execute(params: any, pi: ExtensionAPI, ctx: any) {`,
		logic,
		`}`,
		``,
	].join("\n");
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── forge_tool ──────────────────────────────────────────────────────────

	pi.registerTool({
		name: "forge_tool",
		label: "Forge Tool",
		description:
			"Generate or update a forged tool. Writes a .ts file to extensions/, runs a pre-flight syntax check via jiti, and registers it in the forge registry. If the pre-flight fails, returns the error and source for self-healing.",
		parameters: Type.Object({
			name: Type.String({
				description: "Tool name in snake_case (e.g. sql_explorer). Must match [a-z][a-z0-9_]*",
			}),
			description: Type.String({
				description: "One-sentence description of what the tool does",
			}),
			parametersSchema: Type.String({
				description:
					"TypeBox schema string for the tool parameters, e.g. Type.Object({ query: Type.String() })",
			}),
			logic: Type.String({
				description:
					"TypeScript body of the execute(params, pi, ctx) function. Omit the function signature — just the body.",
			}),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { name, description, parametersSchema, logic } = params;

			// Validate name
			if (!/^[a-z][a-z0-9_]*$/.test(name)) {
				return {
					content: [{ type: "text" as const, text: `Error: name must be snake_case, got "${name}"` }],
				};
			}

			// Validate imports in the logic body
			const violations = validateImports(logic);
			if (violations.length > 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: disallowed imports in logic: ${violations.join(", ")}\nAllowed: ${ALLOWED_IMPORTS.join(", ")}`,
						},
					],
				};
			}

			const tsPath = resolve(__dirname, `forge-${name}.ts`);
			const jsonPath = resolve(__dirname, `forge-${name}.json`);

			// Backup previous version
			if (existsSync(tsPath)) {
				copyFileSync(tsPath, tsPath + ".bak");
			}

			// Write source and metadata
			const source = buildToolSource(name, description, parametersSchema, logic);
			writeFileSync(tsPath, source, "utf8");
			writeFileSync(jsonPath, JSON.stringify({ name, description }, null, 2), "utf8");

			// Pre-flight check via jiti
			try {
				const { createJiti } = await import("jiti");
				const jiti = createJiti(import.meta.url, { cache: false });
				await jiti.import(tsPath);
			} catch (e: unknown) {
				const err = e as Error;
				return {
					content: [
						{
							type: "text" as const,
							text: [
								`Pre-flight FAILED for '${name}':`,
								``,
								err.message,
								``,
								`Source:`,
								"```typescript",
								source,
								"```",
								``,
								`Fix the logic and call forge_tool again.`,
							].join("\n"),
						},
					],
				};
			}

			// Update registry
			registry = loadRegistry();
			const now = new Date().toISOString();
			const existing = registry.tools.findIndex((t) => t.name === name);
			const entry: ForgeEntry = {
				name,
				description,
				path: `extensions/forge-${name}.ts`,
				status: "healthy",
				createdAt: existing >= 0 ? registry.tools[existing].createdAt : now,
				updatedAt: now,
			};
			if (existing >= 0) {
				registry.tools[existing] = entry;
			} else {
				registry.tools.push(entry);
			}
			saveRegistry(registry);

			lastAction = `Forged '${name}'`;
			ctx.ui.notify(`Forged '${name}' successfully`, "success");
			ctx.ui.setStatus("forge-tier", getTier(registry.tools.length));

			return {
				content: [{ type: "text" as const, text: `Tool '${name}' forged and verified. Use use_forge_tool to run it.` }],
			};
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("forge_tool ")) + theme.fg("accent", args.name) + theme.fg("dim", ` — ${args.description}`),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const isError = text.startsWith("Error:") || text.startsWith("Pre-flight FAILED");
			return new Text(theme.fg(isError ? "error" : "success", text.split("\n")[0]), 0, 0);
		},
	});

	// ── use_forge_tool ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "use_forge_tool",
		label: "Use Forge Tool",
		description:
			"Execute a previously forged tool by name. Dynamically imports the tool into the current process and runs its execute() function with the provided params. On failure, returns the stack trace and source code so the agent can self-heal via forge_tool.",
		parameters: Type.Object({
			toolName: Type.String({
				description: "Name of the forged tool to execute (as it appears in list_forge)",
			}),
			toolParams: Type.Record(Type.String(), Type.Unknown(), {
				description: "Parameters to pass to the tool's execute function",
			}),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			registry = loadRegistry();
			const entry = registry.tools.find((t) => t.name === params.toolName);

			if (!entry) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Unknown tool: '${params.toolName}'. Call list_forge to see available tools.`,
						},
					],
				};
			}

			const tsPath = resolve(__dirname, `forge-${params.toolName}.ts`);
			if (!existsSync(tsPath)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Source file missing for '${params.toolName}': ${tsPath}. Re-forge it with forge_tool.`,
						},
					],
				};
			}

			lastAction = `Executing '${params.toolName}'`;
			ctx.ui.notify(`Executing '${params.toolName}'...`, "info");

			try {
				// Cache-bust to pick up latest version after re-forging
				const mod = await import(/* @vite-ignore */ `${tsPath}?t=${Date.now()}`);
				const result = await mod.execute(params.toolParams, pi, ctx);
				lastAction = `Ran '${params.toolName}'`;
				return result ?? { content: [{ type: "text" as const, text: "Done (tool returned no output)" }] };
			} catch (e: unknown) {
				const err = e as Error;
				const source = readFileSync(tsPath, "utf8");

				// Mark tool as broken in registry
				entry.status = "broken";
				saveRegistry(registry);

				lastAction = `Failed '${params.toolName}'`;
				ctx.ui.notify(`Tool '${params.toolName}' failed — self-healing available`, "error");
				ctx.ui.setStatus("forge-tier", getTier(registry.tools.filter((t) => t.status === "healthy").length));

				return {
					content: [
						{
							type: "text" as const,
							text: [
								`TOOL EXECUTION FAILED: ${params.toolName}`,
								``,
								err.message,
								err.stack ?? "",
								``,
								`Source:`,
								"```typescript",
								source,
								"```",
								``,
								`To fix: call forge_tool with the corrected logic. The broken source is shown above.`,
							].join("\n"),
						},
					],
				};
			}
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("use_forge_tool ")) + theme.fg("accent", args.toolName),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const isError = text.startsWith("TOOL EXECUTION FAILED") || text.startsWith("Unknown tool") || text.startsWith("Source file missing");
			return new Text(theme.fg(isError ? "error" : "success", text.split("\n")[0]), 0, 0);
		},
	});

	// ── list_forge ──────────────────────────────────────────────────────────

	pi.registerTool({
		name: "list_forge",
		label: "List Forge",
		description: "List all available forged tools with their descriptions and health status.",
		parameters: Type.Object({}),

		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			registry = loadRegistry();

			if (registry.tools.length === 0) {
				return {
					content: [
						{ type: "text" as const, text: "No tools forged yet. Use forge_tool to create one." },
					],
				};
			}

			const rows = registry.tools
				.map((t) => `| \`${t.name}\` | ${t.description} | ${t.status} | ${t.updatedAt.slice(0, 10)} |`)
				.join("\n");

			return {
				content: [
					{
						type: "text" as const,
						text: `| Name | Description | Status | Updated |\n|---|---|---|---|\n${rows}`,
					},
				],
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("list_forge")), 0, 0);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const count = registry.tools.length;
			return new Text(theme.fg("dim", `${count} forged tool${count === 1 ? "" : "s"}`), 0, 0);
		},
	});

	// ── Events ──────────────────────────────────────────────────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		registry = loadRegistry();
		if (registry.tools.length === 0) return {};

		const healthy = registry.tools.filter((t) => t.status === "healthy");
		if (healthy.length === 0) return {};

		const toolList = healthy.map((t) => `- \`${t.name}\`: ${t.description}`).join("\n");

		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n## Forged Tools Available\n${toolList}\n\nUse \`use_forge_tool\` to invoke any of these. Use \`list_forge\` to refresh the list.`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		registry = loadRegistry();

		ctx.ui.setStatus("forge-tier", getTier(registry.tools.length));

		ctx.ui.setWidget("forge", (_tui, theme) => ({
			render(_width: number): string[] {
				registry = loadRegistry();
				const healthy = registry.tools.filter((t) => t.status === "healthy").length;
				const broken = registry.tools.filter((t) => t.status === "broken").length;

				const header = theme.fg("accent", " ⚒  Agent Forge");
				const countStr = theme.fg("success", `${healthy} tool${healthy === 1 ? "" : "s"}`);
				const brokenStr = broken > 0 ? theme.fg("error", ` · ${broken} broken`) : "";
				const last = theme.fg("dim", ` · Last: ${lastAction}`);

				return [header + "  " + countStr + brokenStr + last];
			},
			invalidate() {},
		}));
	});
}
