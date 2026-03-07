import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@mariozechner/pi-tui";

// ── Types ──────────────────────────────────────────────────────────────

interface PendingApproval {
	toolName: string;
	args: any;
	timestamp: number;
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let pending: PendingApproval | null = null;

	const HIGH_IMPACT_TOOLS = [
		"write",
		"edit",
		"bash",
		"delete_file",
		"move_file",
		"write_file",
		"edit_file",
		"replace",
		"insert",
	];

	function isHighImpact(toolName: string): boolean {
		return HIGH_IMPACT_TOOLS.includes(toolName) || 
		       toolName.includes("write") || 
			   toolName.includes("edit") || 
			   toolName.includes("delete") || 
			   toolName.includes("remove") || 
			   toolName.includes("move");
	}

	function updateWidget(ctx: ExtensionContext) {
		ctx.ui.setWidget("review-queue", (_tui, theme) => {
			const container = new Container();
			
			container.addChild(new Text(theme.fg("accent", theme.bold(" Review Queue ")), 1, 0));
			
			const contentText = new Text("", 1, 0);
			container.addChild(contentText);

			return {
				render(width: number): string[] {
					if (!pending) {
						contentText.setText(theme.fg("dim", " No pending approvals. Safe to proceed."));
						return container.render(width);
					}

					let fullText = theme.fg("warning", " ● PENDING APPROVAL\n\n");
					fullText += theme.fg("accent", " Tool: ") + theme.fg("text", pending.toolName) + "\n";
					
					// Summarize arguments
					let argSummary = "";
					if (pending.args.path) {
						argSummary += theme.fg("dim", " Path: ") + theme.fg("success", pending.args.path) + "\n";
					}
					if (pending.args.command) {
						const cmd = truncateToWidth(pending.args.command.replace(/\n/g, " "), width - 10);
						argSummary += theme.fg("dim", " Cmd:  ") + theme.fg("warning", cmd) + "\n";
					}
					if (pending.args.explanation) {
						const exp = truncateToWidth(pending.args.explanation, width - 10);
						argSummary += theme.fg("dim", " Why:  ") + theme.fg("muted", exp) + "\n";
					}

					if (!argSummary) {
						argSummary = theme.fg("dim", " Args: ") + theme.fg("muted", JSON.stringify(pending.args).slice(0, width - 10));
					}

					fullText += argSummary;

					contentText.setText(fullText);
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				}
			};
		});
	}

	// ── Tool Interception ─────────────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		if (!isHighImpact(event.toolName)) {
			return { block: false };
		}

		// Set pending state
		pending = {
			toolName: event.toolName,
			args: event.input,
			timestamp: Date.now()
		};
		updateWidget(ctx);
		ctx.ui.setStatus("⚠️ Waiting for user approval...", "review-queue");

		// Prepare summary for dialog
		let summary = `Tool: ${event.toolName}\n`;
		if (event.input.path) summary += `Path: ${event.input.path}\n`;
		if (event.input.command) summary += `Command: ${event.input.command}\n`;
		if (event.input.explanation) summary += `Explanation: ${event.input.explanation}\n`;
		
		if (summary.length < 20) {
			summary += `Arguments: ${JSON.stringify(event.input, null, 2)}`;
		}

		// Request confirmation
		const confirmed = await ctx.ui.confirm(
			"🛡️ Review Queue: Tool Approval Required",
			`The agent is attempting to run a high-impact tool:\n\n${summary}\n\nAllow this execution?`,
			{ timeout: 60000 } // 1 minute timeout
		);

		// Clear pending state
		pending = null;
		updateWidget(ctx);
		ctx.ui.setStatus(confirmed ? "✅ Tool approved" : "🛑 Tool blocked", "review-queue");

		if (!confirmed) {
			return { 
				block: true, 
				reason: `🛑 BLOCKED: User denied permission to run ${event.toolName}. DO NOT attempt to retry this tool or circumvent this block. Explain the situation to the user and wait for further instructions.` 
			};
		}

		return { block: false };
	});

	// ── Session Start ──────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		updateWidget(ctx);
		ctx.ui.setStatus("🛡️ Review Queue Active", "review-queue");
		ctx.ui.notify("🛡️ Review-Queue: Intercepting high-impact tool calls for approval.", "info");
	});
}
