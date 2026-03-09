/**
 * SQL Explorer — Connect to and query SQLite & PostgreSQL databases
 *
 * Tools:
 *   sql_connect    — Connect to a SQLite file or PostgreSQL connection string
 *   sql_schema     — List tables or describe a specific table's columns
 *   sql_query      — Execute SQL (SELECT, INSERT, UPDATE, DELETE, etc.)
 *   sql_disconnect — Close the active connection
 *
 * Usage: pi -e extensions/sql-explorer.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";

// ── Types ──────────────────────────────────────────────────────────────

interface ConnectionState {
	type: "sqlite" | "postgresql";
	label: string;
	sqlite?: import("bun:sqlite").Database;
	pg?: import("pg").Client;
}

interface QueryResult {
	columns: string[];
	rows: Record<string, unknown>[];
	rowCount: number;
	command?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

function formatTable(columns: string[], rows: Record<string, unknown>[], maxWidth = 60): string {
	if (columns.length === 0) return "(no columns)";
	if (rows.length === 0) return columns.join(" | ") + "\n(0 rows)";

	// Calculate column widths
	const widths = columns.map((col) => {
		const vals = rows.map((r) => String(r[col] ?? "NULL").length);
		return Math.min(maxWidth, Math.max(col.length, ...vals));
	});

	const header = columns.map((c, i) => c.padEnd(widths[i])).join(" | ");
	const separator = widths.map((w) => "-".repeat(w)).join("-+-");
	const body = rows.map((row) =>
		columns
			.map((c, i) => {
				const val = String(row[c] ?? "NULL");
				return val.length > widths[i] ? val.slice(0, widths[i] - 1) + "…" : val.padEnd(widths[i]);
			})
			.join(" | ")
	);

	return [header, separator, ...body].join("\n");
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let conn: ConnectionState | null = null;

	// Reconstruct connection info from session (not the actual connection — that must be re-established)
	pi.on("session_start", async (_event, ctx) => {
		conn = null;
	});

	pi.on("session_shutdown", async () => {
		await disconnect();
	});

	async function disconnect() {
		if (!conn) return;
		try {
			if (conn.type === "sqlite" && conn.sqlite) {
				conn.sqlite.close();
			} else if (conn.type === "postgresql" && conn.pg) {
				await conn.pg.end();
			}
		} catch {
			// Ignore close errors
		}
		conn = null;
	}

	// ── sql_connect ────────────────────────────────────────────────────

	pi.registerTool({
		name: "sql_connect",
		label: "SQL Connect",
		description: "Connect to a SQLite database file or a PostgreSQL server",
		promptSnippet: "Connect to a SQLite file or PostgreSQL database",
		promptGuidelines: [
			"Use sql_connect before running queries. For SQLite, provide a file path. For PostgreSQL, provide a connection string like postgresql://user:pass@host:port/db.",
			"Only one database connection is active at a time. Connecting to a new database disconnects the previous one.",
		],
		parameters: Type.Object({
			type: StringEnum(["sqlite", "postgresql"] as const, {
				description: "Database type",
			}),
			connection: Type.String({
				description: "SQLite: file path. PostgreSQL: connection string (postgresql://user:pass@host:port/db)",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			// Disconnect existing connection
			await disconnect();

			if (params.type === "sqlite") {
				const { Database } = await import("bun:sqlite");
				const db = new Database(params.connection, { readonly: false });
				db.exec("PRAGMA journal_mode=WAL;");
				conn = { type: "sqlite", label: params.connection, sqlite: db };
				return {
					content: [{ type: "text", text: `Connected to SQLite database: ${params.connection}` }],
					details: { type: "sqlite", connection: params.connection },
				};
			} else {
				const { default: pg } = await import("pg");
				const client = new pg.Client({ connectionString: params.connection });
				await client.connect();
				conn = { type: "postgresql", label: params.connection, pg: client };
				// Mask password in display
				const safeLabel = params.connection.replace(/:([^@]+)@/, ":***@");
				return {
					content: [{ type: "text", text: `Connected to PostgreSQL: ${safeLabel}` }],
					details: { type: "postgresql", connection: safeLabel },
				};
			}
		},

		renderCall(args, theme) {
			const t = theme.fg("toolTitle", theme.bold("sql_connect "));
			const detail = theme.fg("muted", `${args.type}`) + theme.fg("dim", ` → ${args.connection}`);
			return new Text(t + detail, 0, 0);
		},
	});

	// ── sql_schema ─────────────────────────────────────────────────────

	pi.registerTool({
		name: "sql_schema",
		label: "SQL Schema",
		description: "List tables in the database, or describe columns of a specific table",
		promptSnippet: "Inspect database schema — list tables or describe a table's columns",
		parameters: Type.Object({
			table: Type.Optional(
				Type.String({ description: "Table name to describe. Omit to list all tables." })
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!conn) throw new Error("No database connection. Use sql_connect first.");

			if (!params.table) {
				// List tables
				let tables: string[];
				if (conn.type === "sqlite") {
					const rows = conn.sqlite!.query(
						"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
					).all() as { name: string }[];
					tables = rows.map((r) => r.name);
				} else {
					const res = await conn.pg!.query(
						"SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
					);
					tables = res.rows.map((r: any) => r.table_name);
				}

				const text = tables.length === 0
					? "No tables found."
					: `Tables (${tables.length}):\n${tables.map((t) => `  • ${t}`).join("\n")}`;

				return {
					content: [{ type: "text", text }],
					details: { tables },
				};
			} else {
				// Describe table
				let columns: { name: string; type: string; nullable: string; pk: boolean }[];

				if (conn.type === "sqlite") {
					const rows = conn.sqlite!.query(`PRAGMA table_info("${params.table}")`).all() as any[];
					columns = rows.map((r) => ({
						name: r.name,
						type: r.type || "ANY",
						nullable: r.notnull ? "NO" : "YES",
						pk: !!r.pk,
					}));
				} else {
					const res = await conn.pg!.query(
						`SELECT column_name, data_type, is_nullable, 
						 (SELECT true FROM information_schema.table_constraints tc
						  JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
						  WHERE tc.table_name = c.table_name AND kcu.column_name = c.column_name 
						  AND tc.constraint_type = 'PRIMARY KEY' LIMIT 1) as is_pk
						 FROM information_schema.columns c
						 WHERE table_schema = 'public' AND table_name = $1
						 ORDER BY ordinal_position`,
						[params.table]
					);
					columns = res.rows.map((r: any) => ({
						name: r.column_name,
						type: r.data_type,
						nullable: r.is_nullable,
						pk: !!r.is_pk,
					}));
				}

				if (columns.length === 0) throw new Error(`Table "${params.table}" not found or has no columns.`);

				const lines = columns.map(
					(c) => `  ${c.pk ? "🔑 " : "   "}${c.name} ${c.type}${c.nullable === "YES" ? " (nullable)" : ""}`
				);
				const text = `Table: ${params.table} (${columns.length} columns)\n${lines.join("\n")}`;

				return {
					content: [{ type: "text", text }],
					details: { table: params.table, columns },
				};
			}
		},

		renderCall(args, theme) {
			const t = theme.fg("toolTitle", theme.bold("sql_schema "));
			const detail = args.table ? theme.fg("accent", args.table) : theme.fg("dim", "(list tables)");
			return new Text(t + detail, 0, 0);
		},
	});

	// ── sql_query ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "sql_query",
		label: "SQL Query",
		description: "Execute a SQL query and return results",
		promptSnippet: "Execute SQL queries (SELECT, INSERT, UPDATE, DELETE, CREATE, etc.)",
		promptGuidelines: [
			"For SELECT queries, results are returned as a formatted table. Large result sets are truncated.",
			"For INSERT/UPDATE/DELETE, the affected row count is returned.",
			"Use sql_schema first to understand the table structure before writing queries.",
		],
		parameters: Type.Object({
			sql: Type.String({ description: "SQL query to execute" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!conn) throw new Error("No database connection. Use sql_connect first.");

			let result: QueryResult;

			if (conn.type === "sqlite") {
				const sql = params.sql.trim();
				const isSelect = /^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(sql);

				if (isSelect) {
					const rows = conn.sqlite!.query(sql).all() as Record<string, unknown>[];
					const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
					result = { columns, rows, rowCount: rows.length, command: "SELECT" };
				} else {
					const info = conn.sqlite!.run(sql);
					result = {
						columns: [],
						rows: [],
						rowCount: info.changes,
						command: sql.split(/\s/)[0].toUpperCase(),
					};
				}
			} else {
				const res = await conn.pg!.query(params.sql);
				if (res.fields && res.rows) {
					const columns = res.fields.map((f: any) => f.name);
					result = {
						columns,
						rows: res.rows,
						rowCount: res.rowCount ?? res.rows.length,
						command: res.command,
					};
				} else {
					result = {
						columns: [],
						rows: [],
						rowCount: res.rowCount ?? 0,
						command: res.command,
					};
				}
			}

			// Format output
			let text: string;
			if (result.rows.length > 0) {
				const table = formatTable(result.columns, result.rows);
				text = `${table}\n\n(${result.rowCount} row${result.rowCount !== 1 ? "s" : ""})`;
			} else if (result.command === "SELECT") {
				text = "(0 rows)";
			} else {
				text = `${result.command}: ${result.rowCount} row${result.rowCount !== 1 ? "s" : ""} affected`;
			}

			// Truncate if needed
			const truncation = truncateHead(text, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let output = truncation.content;
			if (truncation.truncated) {
				output += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
				output += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
			}

			return {
				content: [{ type: "text", text: output }],
				details: {
					command: result.command,
					rowCount: result.rowCount,
					columns: result.columns,
					truncated: truncation.truncated,
				},
			};
		},

		renderCall(args, theme) {
			const t = theme.fg("toolTitle", theme.bold("sql_query "));
			// Show first line of SQL, truncated
			const firstLine = args.sql.split("\n")[0].slice(0, 80);
			const suffix = args.sql.includes("\n") || args.sql.length > 80 ? "…" : "";
			return new Text(t + theme.fg("dim", firstLine + suffix), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Executing…"), 0, 0);

			const details = result.details as any;
			if (result.isError) {
				return new Text(theme.fg("error", result.content?.[0]?.text ?? "Query failed"), 0, 0);
			}

			const info = theme.fg("success", `${details?.command ?? "OK"}`) +
				theme.fg("dim", ` — ${details?.rowCount ?? 0} row(s)`) +
				(details?.truncated ? theme.fg("warning", " [truncated]") : "");

			const body = result.content?.[0]?.text ?? "";
			return new Text(info + "\n" + theme.fg("dim", body), 0, 0);
		},
	});

	// ── sql_disconnect ─────────────────────────────────────────────────

	pi.registerTool({
		name: "sql_disconnect",
		label: "SQL Disconnect",
		description: "Close the active database connection",
		promptSnippet: "Close the current database connection",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			if (!conn) {
				return {
					content: [{ type: "text", text: "No active connection to close." }],
					details: {},
				};
			}
			const label = conn.label;
			await disconnect();
			return {
				content: [{ type: "text", text: `Disconnected from ${label}` }],
				details: { disconnected: label },
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("sql_disconnect")), 0, 0);
		},
	});
}
