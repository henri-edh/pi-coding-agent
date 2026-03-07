import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@mariozechner/pi-tui";

// ── Types ──────────────────────────────────────────────────────────────

interface Thought {
	id: string;
	content: string;
	timestamp: number;
	isStreaming: boolean;
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const thoughts: Thought[] = [];
	const MAX_HISTORY = 3;
	let currentMessageId: string | null = null;

	function getOrCreateThought(messageId: string): Thought {
		let thought = thoughts.find(t => t.id === messageId);
		if (!thought) {
			thought = {
				id: messageId,
				content: "",
				timestamp: Date.now(),
				isStreaming: true
			};
			thoughts.push(thought);
			if (thoughts.length > MAX_HISTORY + 1) {
				thoughts.shift();
			}
		}
		return thought;
	}

	function updateWidget(ctx: ExtensionContext) {
		ctx.ui.setWidget("thought-bubble", (_tui, theme) => {
			const container = new Container();
			const borderFn = (s: string) => theme.fg("accent", s);

			container.addChild(new Text(theme.fg("accent", theme.bold(" Thought Bubble ")), 1, 0));
			container.addChild(new DynamicBorder(borderFn));
			
			const contentText = new Text("", 1, 0);
			container.addChild(contentText);
			container.addChild(new DynamicBorder(borderFn));

			return {
				render(width: number): string[] {
					if (thoughts.length === 0) {
						contentText.setText(theme.fg("dim", " No thoughts yet..."));
						return container.render(width);
					}

					let fullText = "";
					
					// Show previous thoughts (dimmed and truncated)
					const history = thoughts.slice(0, -1);
					for (const t of history) {
						const preview = t.content.split("\n")[0] || "";
						const line = theme.fg("dim", "• " + (preview.length > width - 5 ? preview.slice(0, width - 8) + "..." : preview));
						fullText += line + "\n";
					}

					if (history.length > 0) fullText += "\n";

					// Show current thought
					const current = thoughts[thoughts.length - 1];
					const statusIcon = current.isStreaming ? theme.fg("accent", "● ") : theme.fg("success", "○ ");
					const rawLines = current.content.split("\n");
					
					// We only show the last few lines of the current thought to keep it compact
					const visibleLines = rawLines.slice(-10);
					const content = visibleLines.map(l => truncateToWidth(l, width - 4)).join("\n");
					
					fullText += statusIcon + (current.isStreaming ? theme.fg("text", "Reasoning...") : theme.fg("muted", "Final Logic")) + "\n";
					fullText += theme.fg("success", content);

					contentText.setText(fullText);
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				}
			};
		});
	}

	// ── Message Event Handlers ─────────────────────────────────────────

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role === "assistant") {
			currentMessageId = event.message.id;
			// Check if message already has a thought property (from some providers)
			const thoughtContent = (event.message as any).thought || "";
			if (thoughtContent) {
				const t = getOrCreateThought(currentMessageId);
				t.content = thoughtContent;
				updateWidget(ctx);
			}
		}
	});

	pi.on("message_update", async (event, ctx) => {
		if (event.message.role !== "assistant" || !currentMessageId) return;

		const delta = event.assistantMessageEvent;
		if (!delta) return;

		const thought = getOrCreateThought(currentMessageId);

		// 1. Check for explicit thought_delta (some providers might support this in the future)
		if ((delta as any).type === "thought_delta") {
			thought.content += (delta as any).delta || "";
		} 
		// 2. Check for content inside <thought> tags in the text_delta
		else if (delta.type === "text_delta") {
			const fullText = event.message.content.map(c => c.type === "text" ? c.text : "").join("");
			
			// Extract everything between <thought> and </thought>
			// This regex handles partial tags during streaming
			const thoughtMatch = fullText.match(/<thought>([\s\S]*?)(?:<\/thought>|$)/);
			if (thoughtMatch) {
				thought.content = thoughtMatch[1].trim();
			}
		}

		updateWidget(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "assistant" && event.message.id === currentMessageId) {
			const thought = thoughts.find(t => t.id === currentMessageId);
			if (thought) {
				thought.isStreaming = false;
				
				// Final check for thought property
				const finalThought = (event.message as any).thought;
				if (finalThought) {
					thought.content = finalThought;
				}
			}
			currentMessageId = null;
			updateWidget(ctx);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		updateWidget(ctx);
	});
}
