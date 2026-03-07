import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

interface Snapshot {
	id: string; // The stash hash
	timestamp: number;
	label: string;
	branch: string;
}

interface SnapshotVaultState {
	snapshots: Snapshot[];
}

const SnapshotParams = Type.Object({
	action: StringEnum(["save", "list", "restore"] as const),
	label: Type.Optional(Type.String({ description: "Optional label for the snapshot" })),
	id: Type.Optional(Type.String({ description: "The snapshot ID (hash) to restore" })),
});

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let state: SnapshotVaultState = { snapshots: [] };
	let vaultPath = "";

	function getVaultPath(cwd: string) {
		const piDir = join(cwd, ".pi");
		if (!existsSync(piDir)) {
			mkdirSync(piDir, { recursive: true });
		}
		return join(piDir, "snapshots.json");
	}

	function loadState(cwd: string) {
		vaultPath = getVaultPath(cwd);
		if (existsSync(vaultPath)) {
			try {
				state = JSON.parse(readFileSync(vaultPath, "utf-8"));
			} catch {
				state = { snapshots: [] };
			}
		} else {
			state = { snapshots: [] };
		}
	}

	function saveState() {
		if (vaultPath) {
			writeFileSync(vaultPath, JSON.stringify(state, null, 2));
		}
	}

	async function getBranch(cwd: string): Promise<string> {
		try {
			const { stdout } = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
			return stdout.trim() || "unknown";
		} catch {
			return "no-git";
		}
	}

	function updateWidget(ctx: ExtensionContext) {
		const lastSnapshot = state.snapshots.length > 0 
			? state.snapshots[state.snapshots.length - 1] 
			: null;
		
		ctx.ui.setWidget("snapshot-status", (_tui, theme) => {
			const text = new Text("", 0, 0);
			return {
				render(width: number): string[] {
					const count = state.snapshots.length;
					let content = theme.fg("dim", " Vault: ") + theme.fg("accent", `${count} snapshots`);
					
					if (lastSnapshot) {
						const date = new Date(lastSnapshot.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
						content += theme.fg("dim", " | Last: ") + theme.fg("success", date);
					}

					text.setText(" " + content + " ");
					return text.render(width);
				},
				invalidate() {
					text.invalidate();
				}
			};
		});
	}

	// ── Snapshot Actions ───────────────────────────────────────────────

	async function saveSnapshot(ctx: ExtensionContext, label?: string) {
		try {
			// 1. Check if git
			await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ctx.cwd });
			
			// 2. Create stash
			const { stdout: hash, code, stderr } = await pi.exec("git", ["stash", "create"], { cwd: ctx.cwd });
			if (code !== 0) {
				return { error: `Git error: ${stderr}` };
			}
			if (!hash.trim()) {
				return { error: "No changes to snapshot (working tree clean)." };
			}

			const id = hash.trim();
			const branch = await getBranch(ctx.cwd);
			const timestamp = Date.now();
			const finalLabel = label || `Snapshot ${new Date(timestamp).toLocaleString()}`;

			// 3. Store stash so it persists
			await pi.exec("git", ["stash", "store", "-m", `Vault: ${finalLabel}`, id], { cwd: ctx.cwd });

			const snapshot: Snapshot = { id, timestamp, label: finalLabel, branch };
			state.snapshots.push(snapshot);
			saveState();
			updateWidget(ctx);

			return { snapshot };
		} catch (err: any) {
			return { error: `Git error: ${err.message || err}` };
		}
	}

	async function restoreSnapshot(ctx: ExtensionContext, id: string) {
		try {
			const snapshot = state.snapshots.find(s => s.id === id);
			if (!snapshot) return { error: `Snapshot ${id} not found.` };

			// Warn user if branch mismatch
			const currentBranch = await getBranch(ctx.cwd);
			if (currentBranch !== snapshot.branch) {
				const confirm = await ctx.ui.confirm(
					"Branch Mismatch",
					`Snapshot was taken on '${snapshot.branch}', but you are on '${currentBranch}'. Restore anyway?`
				);
				if (!confirm) return { error: "Restore cancelled by user." };
			}

			// Apply stash
			const { code, stderr } = await pi.exec("git", ["stash", "apply", id], { cwd: ctx.cwd });
			if (code !== 0) {
				return { error: `Restore failed: ${stderr}` };
			}

			return { success: true, snapshot };
		} catch (err: any) {
			return { error: `Restore failed: ${err.message || err}` };
		}
	}

	// ── Tool Registration ──────────────────────────────────────────────

	pi.registerTool({
		name: "snapshot",
		label: "Snapshot Vault",
		description: "Create, list, or restore workspace snapshots using git stash.",
		parameters: SnapshotParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "save": {
					const result = await saveSnapshot(ctx, params.label);
					if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
					return {
						content: [{ type: "text", text: `Snapshot saved: ${result.snapshot?.label} (${result.snapshot?.id.slice(0, 7)})` }],
						details: result
					};
				}
				case "list": {
					if (state.snapshots.length === 0) return { content: [{ type: "text", text: "No snapshots found in vault." }] };
					const list = state.snapshots.map(s => 
						`[${new Date(s.timestamp).toLocaleString()}] ${s.label} (${s.id.slice(0, 7)}) on branch ${s.branch}`
					).join("\n");
					return { content: [{ type: "text", text: `Snapshots:\n${list}` }] };
				}
				case "restore": {
					if (!params.id) return { content: [{ type: "text", text: "ID required for restore." }], isError: true };
					const result = await restoreSnapshot(ctx, params.id);
					if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
					return {
						content: [{ type: "text", text: `Snapshot restored: ${result.snapshot?.label}` }],
						details: result
					};
				}
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("snapshot ")) + theme.fg("muted", args.action);
			if (args.label) text += ` ${theme.fg("dim", `"${args.label}"`)}`;
			if (args.id) text += ` ${theme.fg("accent", args.id.slice(0, 7))}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			if (result.isError) {
				const text = result.content[0];
				return new Text(theme.fg("error", text?.type === "text" ? text.text : "Error"), 0, 0);
			}
			const text = result.content[0];
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text?.type === "text" ? text.text : "Done"), 0, 0);
		}
	});

	// ── Slash Command ──────────────────────────────────────────────────

	pi.registerCommand("snapshot", {
		description: "Manage snapshots interactively",
		handler: async (_args, ctx) => {
			if (state.snapshots.length === 0) {
				ctx.ui.notify("No snapshots found in vault.", "warning");
				return;
			}

			const options = state.snapshots.slice().reverse().map(s => {
				const date = new Date(s.timestamp).toLocaleString();
				return `${s.label} (${s.id.slice(0, 7)}) — ${date} [${s.branch}]`;
			});

			const choice = await ctx.ui.select("Restore Snapshot", options);
			if (!choice) return;

			const idx = options.indexOf(choice);
			const snapshot = state.snapshots.slice().reverse()[idx];

			const confirm = await ctx.ui.confirm("Restore Snapshot", `Restore '${snapshot.label}'? Unsaved changes may be overwritten or cause conflicts.`);
			if (!confirm) return;

			const result = await restoreSnapshot(ctx, snapshot.id);
			if (result.error) {
				ctx.ui.notify(result.error, "error");
			} else {
				ctx.ui.notify(`Restored: ${snapshot.label}`, "success");
			}
		}
	});

	// ── Lifecycle ──────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		loadState(ctx.cwd);
		updateWidget(ctx);
	});
}
