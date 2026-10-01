import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import type { Params, TernExec, ToolRegistration } from "../types";
import { runTern, text } from "../exec";
import { actionOf, optionalBoolean, optionalInteger, ternTarget } from "../validation";

type JsonObject = Record<string, unknown>;
type Host = TernExec & { env: NodeJS.ProcessEnv };

/** argv[0] basenames that identify an agent CLI on their own. */
const AGENT_BINARIES: Record<string, string> = {
	omp: "omp",
	pi: "pi",
	claude: "claude",
	codex: "codex",
	opencode: "opencode",
	gemini: "gemini",
	amp: "amp",
	"cursor-agent": "cursor",
	kiro: "kiro",
	grok: "grok",
	copilot: "copilot",
};
/** Script runtimes a development omp or pi runs under (`bun … coding-agent/src/cli.ts`). */
const SCRIPT_RUNTIMES: Record<string, true> = { bun: true, node: true, deno: true, tsx: true };
const SCRIPT_MARKERS = ["/pi-coding-agent/", "/coding-agent/scripts/omp.ts", "/coding-agent/src/cli.ts"];
const TRANSCRIPT_KINDS: Record<string, true> = { omp: true, pi: true };
const MAX_TRANSCRIPT_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_DIGEST_MESSAGE_CHARS = 2_000;

export interface AgentSession {
	session: string;
	tab: number | null;
	block: string;
	title: string | null;
	cwd: string | null;
	kind: string;
	pid: number | null;
	focused: boolean;
	isSelf: boolean;
	transcript: string | null;
}

function object(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function objects(value: unknown): JsonObject[] {
	return Array.isArray(value) ? value.map(object).filter((item): item is JsonObject => item !== undefined) : [];
}

function string(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function number(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function agentKind(argv: readonly string[]): string | null {
	if (argv.length === 0) return null;
	const name = basename(argv[0]);
	if (AGENT_BINARIES[name]) return AGENT_BINARIES[name];
	if (SCRIPT_RUNTIMES[name] && argv.slice(1).some((arg) => SCRIPT_MARKERS.some((marker) => arg.includes(marker)))) {
		return "omp";
	}
	return null;
}

/**
 * The top-level session transcript among a process's open files. omp and pi
 * keep `<root>/sessions/<cwd-slug>/<file>.jsonl` open for the session's life;
 * subagent transcripts nest one level deeper, so the grandparent directory
 * being `sessions` singles out the main one.
 */
export function pickTranscript(openFiles: readonly string[], mtime: (path: string) => number): string | null {
	const candidates = openFiles.filter(
		(path) => path.endsWith(".jsonl") && basename(dirname(dirname(path))) === "sessions",
	);
	if (candidates.length === 0) return null;
	return candidates.reduce((best, path) => (mtime(path) > mtime(best) ? path : best));
}

function fileMtime(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

async function openTranscript(host: Host, group: number | null, pid: number | null, signal?: AbortSignal) {
	let pids: string[] = [];
	if (group !== null) {
		const listed = await host.exec("pgrep", ["-g", String(group)], { signal, timeout: 5_000 });
		pids = listed.stdout.split(/\s+/).filter(Boolean);
	}
	if (pids.length === 0 && pid !== null) pids = [String(pid)];
	if (pids.length === 0) return null;
	const lsof = await host.exec("lsof", ["-Fn", "-p", pids.join(",")], { signal, timeout: 5_000 });
	const files = lsof.stdout
		.split("\n")
		.filter((line) => line.startsWith("n"))
		.map((line) => line.slice(1));
	return pickTranscript(files, fileMtime);
}

async function ternJson(host: Host, args: string[], signal?: AbortSignal): Promise<JsonObject> {
	const result = await runTern(host, [...args, "--json"], { signal });
	if (result.code !== 0 || result.killed) {
		const reason = (result.stderr || result.stdout).trim() || `exit code ${result.code}`;
		throw new Error(`tern ${args.join(" ")}: ${reason}`);
	}
	const parsed = object(JSON.parse(result.stdout));
	if (!parsed) throw new Error(`tern ${args.join(" ")} returned non-object JSON`);
	return parsed;
}

interface Discovery {
	scope: "caller-session" | "all";
	sessions: AgentSession[];
}

export async function discoverAgents(host: Host, all: boolean, signal?: AbortSignal): Promise<Discovery> {
	const tree = await ternJson(host, ["ls"], signal);
	const caller = host.env.TERN_PANE?.trim() || undefined;
	const sessions = objects(tree.sessions);
	const callerSession = caller
		? sessions.find((session) =>
				objects(session.tabs).some((tab) => objects(tab.blocks).some((block) => String(block.id) === caller)),
			)
		: undefined;
	const scoped = all || !callerSession ? sessions : [callerSession];

	const candidates = scoped.flatMap((session) =>
		objects(session.tabs).flatMap((tab) =>
			objects(tab.blocks)
				.filter((block) => block.exited === null || block.exited === undefined)
				.map((block) => ({ session, tab, block })),
		),
	);
	const rows = await Promise.all(
		candidates.map(async ({ session, tab, block }): Promise<AgentSession | null> => {
			const id = String(block.id);
			let process: JsonObject;
			try {
				process = await ternJson(host, ["process", id], signal);
			} catch {
				return null; // the block closed between `ls` and `process`
			}
			const foreground = object(process.foreground) ?? object(process.child) ?? {};
			const argv = Array.isArray(foreground.argv) ? foreground.argv.filter((arg) => typeof arg === "string") : [];
			const kind = agentKind(argv);
			if (!kind) return null;
			const pid = number(foreground.pid);
			const transcript = TRANSCRIPT_KINDS[kind] ? await openTranscript(host, number(process.group), pid, signal) : null;
			return {
				session: string(session.name) ?? String(session.id),
				tab: number(tab.number),
				block: id,
				title: string(block.title),
				cwd: string(foreground.cwd) ?? string(block.cwd),
				kind,
				pid,
				focused: block.focused === true,
				isSelf: caller === id,
				transcript,
			};
		}),
	);
	return {
		scope: all || !callerSession ? "all" : "caller-session",
		sessions: rows.filter((row): row is AgentSession => row !== null),
	};
}

interface TranscriptMessage {
	timestamp: string | null;
	role: "user" | "assistant";
	text: string;
	truncated: boolean;
}

function textContent(message: JsonObject): string {
	const content = message.content;
	if (typeof content === "string") return content.trim();
	return objects(content)
		.filter((part) => part.type === "text")
		.map((part) => string(part.text) ?? "")
		.filter(Boolean)
		.join("\n")
		.trim();
}

/**
 * Last `limit` user and assistant text messages, scanning at most the final
 * 8 MiB. Thinking blocks, tool calls and tool results are never included.
 */
export function transcriptDigest(path: string, limit: number) {
	const size = statSync(path).size;
	const length = Math.min(size, MAX_TRANSCRIPT_SCAN_BYTES);
	const start = size - length;
	const buffer = Buffer.allocUnsafe(length);
	const descriptor = openSync(path, "r");
	let read = 0;
	try {
		while (read < length) {
			const count = readSync(descriptor, buffer, read, length - read, start + read);
			if (count === 0) break;
			read += count;
		}
	} finally {
		closeSync(descriptor);
	}
	let body = buffer.subarray(0, read).toString("utf8");
	if (start > 0) body = body.slice(body.indexOf("\n") + 1);

	const messages: TranscriptMessage[] = [];
	let title: string | null = null;
	let model: string | null = null;
	const lines = body.split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		let event: JsonObject | undefined;
		try {
			event = object(JSON.parse(lines[index]));
		} catch {
			continue;
		}
		if (!event) continue;
		if (title === null && (event.type === "title" || event.type === "title_change")) title = string(event.title);
		if (model === null && event.type === "model_change") model = string(event.model);
		if (event.type !== "message" || messages.length >= limit) continue;
		const message = object(event.message);
		const role = message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const content = textContent(message as JsonObject);
		if (!content) continue;
		const truncated = content.length > MAX_DIGEST_MESSAGE_CHARS;
		messages.push({
			timestamp: string(event.timestamp),
			role,
			text: truncated ? `${content.slice(0, MAX_DIGEST_MESSAGE_CHARS)}\n… message truncated` : content,
			truncated,
		});
	}
	messages.reverse();
	return { title, model, messages, scanTruncated: start > 0 };
}

function displayPath(path: string | null): string | null {
	const home = homedir();
	return path?.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export function makeAgentsExecute(host: Host): ToolRegistration["execute"] {
	return async (_id, params: Params, signal) => {
		const action = typeof params.action === "string" ? params.action : "invalid";
		const details: Record<string, unknown> = { action };
		try {
			const requested = actionOf(params);
			if (requested === "list") {
				const includeSelf = optionalBoolean(params, "include_self") ?? false;
				const found = await discoverAgents(host, optionalBoolean(params, "all") ?? false, signal);
				const sessions = found.sessions
					.filter((session) => includeSelf || !session.isSelf)
					.map((session) => ({ ...session, transcript: displayPath(session.transcript) }));
				const result = {
					scope: found.scope,
					selfIdentification: host.env.TERN_PANE ? "TERN_PANE" : "unavailable (not inside a Tern pane)",
					count: sessions.length,
					sessions,
				};
				return text(JSON.stringify(result, null, 2), { ...details, count: sessions.length });
			}
			if (requested !== "digest") throw new Error(`unsupported tern_agents action: ${requested}`);

			const block = ternTarget(params, "block", true);
			const limit = optionalInteger(params, "messages", 1, 20) ?? 8;
			const found = await discoverAgents(host, true, signal);
			const session = found.sessions.find((row) => row.block === block);
			if (!session) {
				throw new Error(`no live agent in block ${block}; list agents with tern_agents action=list all=true`);
			}
			if (!TRANSCRIPT_KINDS[session.kind]) {
				throw new Error(
					`block ${block} runs ${session.kind}, whose transcript format is not parsed; read it with tern_state action=capture block=${block}`,
				);
			}
			if (!session.transcript) {
				throw new Error(`block ${block}: the ${session.kind} process holds no session transcript open yet`);
			}
			const digest = transcriptDigest(session.transcript, limit);
			const result = {
				session: { ...session, transcript: displayPath(session.transcript) },
				title: digest.title,
				model: digest.model,
				requestedMessages: limit,
				scanTruncated: digest.scanTruncated,
				messages: digest.messages,
			};
			return text(JSON.stringify(result, null, 2), { ...details, block });
		} catch (error) {
			return text(`tern agents failed: ${error instanceof Error ? error.message : String(error)}`, details, true);
		}
	};
}
