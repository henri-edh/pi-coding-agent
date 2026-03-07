import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

interface GitStatus {
	branch: string;
	added: number;
	modified: number;
	deleted: number;
}

export default function (pi: ExtensionAPI) {
	let currentStatus: GitStatus | null = null;

	/**
	 * Run git status --porcelain -b to get current branch and changes.
	 * Porcelain output format:
	 *   XY path
	 *   X = index status, Y = work tree status
	 *   A = Added, M = Modified, D = Deleted, ? = Untracked, R = Renamed, C = Copied
	 */
	async function updateGitStatus(ctx: any) {
		try {
			const { stdout, code } = await pi.exec("git", ["status", "--porcelain", "-b"], { cwd: ctx.cwd });
			if (code !== 0) {
				currentStatus = null;
			} else {
				const lines = stdout.split("\n").filter(l => l.trim().length > 0);
				if (lines.length === 0) {
					currentStatus = { branch: "Unknown", added: 0, modified: 0, deleted: 0 };
				} else {
					const branchLine = lines[0];
					const branch = branchLine.startsWith("## ") 
						? branchLine.slice(3).split("...")[0].trim() 
						: "Detached/Unknown";

					let added = 0;
					let modified = 0;
					let deleted = 0;

					for (let i = 1; i < lines.length; i++) {
						const line = lines[i];
						const status = line.slice(0, 2);
						
						// Added: staged added (A) or untracked (?)
						if (status.includes("A") || status.includes("?")) added++;
						
						// Modified: staged/unstaged modified (M), renamed (R), or copied (C)
						if (status.includes("M") || status.includes("R") || status.includes("C")) modified++;
						
						// Deleted: staged/unstaged deleted (D)
						if (status.includes("D")) deleted++;
					}
					currentStatus = { branch, added, modified, deleted };
				}
			}
		} catch (e) {
			currentStatus = null;
		}
		renderWidget(ctx);
	}

	function renderWidget(ctx: any) {
		ctx.ui.setWidget("git-signal", (_tui: any, theme: any) => {
			const text = new Text("", 0, 0);
			return {
				render(width: number): string[] {
					if (!currentStatus) {
						text.setText(theme.fg("dim", " No Git "));
						return text.render(width);
					}

					const { branch, added, modified, deleted } = currentStatus;
					const branchColor = (added + modified + deleted) > 0 ? "warning" : "accent";
					let output = theme.fg("dim", " Git: ") + theme.fg(branchColor, branch);
					
					const parts: string[] = [];
					if (added > 0) parts.push(theme.fg("success", `+${added}`));
					if (modified > 0) parts.push(theme.fg("warning", `~${modified}`));
					if (deleted > 0) parts.push(theme.fg("error", `-${deleted}`));

					if (parts.length > 0) {
						output += theme.fg("dim", " [") + parts.join(theme.fg("dim", ", ")) + theme.fg("dim", "]");
					} else {
						output += theme.fg("dim", " (clean)");
					}

					text.setText(" " + output + " ");
					return text.render(width);
				},
				invalidate() {
					text.invalidate();
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		await updateGitStatus(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		// Update on any tool that might change the filesystem.
		// Includes standard tools and common variations like write_file.
		const toolName = event.toolName;
		const isFsTool = toolName === "write" || 
		                 toolName === "edit" || 
						 toolName === "bash" || 
						 toolName === "delete_file" || 
						 toolName === "move_file" || 
						 toolName.includes("write") || 
						 toolName.includes("edit");
		
		if (isFsTool) {
			await updateGitStatus(ctx);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		await updateGitStatus(ctx);
	});
}
