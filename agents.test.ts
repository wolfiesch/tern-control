import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAgentsExecute, pickTranscript } from "./src/index";
import type { ExecResult, ToolRegistration } from "./src/types";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const OMP_ARGV = ["bun", "--preload", "/src/packages/coding-agent/scripts/omp.ts", "/src/packages/coding-agent/src/cli.ts"];

function transcriptFixture(): { main: string; subagent: string } {
	const root = mkdtempSync(join(tmpdir(), "tern-agents-"));
	directories.push(root);
	const slug = join(root, "sessions", "--repo--");
	mkdirSync(join(slug, "01a0-session"), { recursive: true });
	const main = join(slug, "2026-10-01T00-00-00-000Z_01a0-session.jsonl");
	const subagent = join(slug, "01a0-session", "0-Scout.jsonl");
	const lines = [
		{ type: "session", id: "01a0-session", cwd: "/repo" },
		{ type: "model_change", model: "provider/model-a" },
		{ type: "message", timestamp: "t1", message: { role: "user", content: "first ask" } },
		{
			type: "message",
			timestamp: "t2",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private reasoning" },
					{ type: "text", text: "visible answer" },
					{ type: "toolCall", name: "bash", arguments: { command: "secret" } },
				],
			},
		},
		{ type: "message", timestamp: "t3", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } },
		{ type: "title_change", title: "Fix the build" },
		{ type: "message", timestamp: "t4", message: { role: "user", content: "second ask" } },
	];
	writeFileSync(main, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	writeFileSync(subagent, "{}\n");
	return { main, subagent };
}

/** Default session: 10 = caller omp, 11 = peer omp, 12 = zsh, 13 = exited; scratch: 20 = claude. */
function fakeHost(transcript: string, env: NodeJS.ProcessEnv = { TERN_PANE: "10" }) {
	const tree = {
		sessions: [
			{
				id: 4,
				name: "Default",
				tabs: [
					{
						number: 1,
						blocks: [
							{ id: 10, title: "π > me", exited: null, focused: true },
							{ id: 11, title: "π > peer", exited: null },
							{ id: 12, title: "~", exited: null },
							{ id: 13, title: "done", exited: 0 },
						],
					},
				],
			},
			{ id: 7, name: "scratch", tabs: [{ number: 2, blocks: [{ id: 20, title: "claude", exited: null }] }] },
		],
	};
	const foreground: Record<string, { pid: number; argv: string[]; cwd: string }> = {
		"10": { pid: 100, argv: ["omp"], cwd: "/me" },
		"11": { pid: 110, argv: OMP_ARGV, cwd: "/repo" },
		"12": { pid: 120, argv: ["/bin/zsh", "-l"], cwd: "/" },
		"20": { pid: 200, argv: ["/usr/local/bin/claude"], cwd: "/other" },
	};
	const exec = async (command: string, args: string[]): Promise<ExecResult> => {
		const ok = (stdout: string) => ({ stdout, stderr: "", code: 0, killed: false });
		if (command === "/opt/tern" && args[0] === "ls") return ok(JSON.stringify(tree));
		if (command === "/opt/tern" && args[0] === "process") {
			const fg = foreground[args[1]];
			return ok(JSON.stringify({ pane: Number(args[1]), group: fg.pid, foreground: fg }));
		}
		if (command === "pgrep") return ok(`${args[1]}\n`);
		if (command === "lsof") {
			const files = args[2] === "110" ? ["/dev/ttys001", transcript, transcript.replace(/[^/]+$/, "01a0-session/0-Scout.jsonl")] : [];
			return ok(files.map((file) => `n${file}`).join("\n"));
		}
		throw new Error(`unexpected ${command} ${args.join(" ")}`);
	};
	return makeAgentsExecute({ exec, env: { TERN_BIN: "/opt/tern", ...env } });
}

async function json(execute: ToolRegistration["execute"], params: Record<string, unknown>) {
	const result = await execute("call", params);
	return { result, body: result.isError ? null : JSON.parse(result.content[0].text) };
}

describe("pickTranscript", () => {
	test("selects the newest top-level session file and ignores subagent transcripts", () => {
		const mtimes: Record<string, number> = {
			"/h/sessions/a/old.jsonl": 1,
			"/h/sessions/a/new.jsonl": 2,
			"/h/sessions/a/new/0-Scout.jsonl": 9,
		};
		expect(pickTranscript([...Object.keys(mtimes), "/dev/ttys001"], (path) => mtimes[path])).toBe("/h/sessions/a/new.jsonl");
		expect(pickTranscript(["/h/sessions/a/new/0-Scout.jsonl"], () => 0)).toBeNull();
	});
});

describe("tern_agents list", () => {
	test("scopes to the caller's session, drops the caller, shells and exited blocks", async () => {
		const { main } = transcriptFixture();
		const { body } = await json(fakeHost(main), { action: "list" });
		expect(body.scope).toBe("caller-session");
		expect(body.sessions.map((row: { block: string }) => row.block)).toEqual(["11"]);
		expect(body.sessions[0]).toMatchObject({ kind: "omp", cwd: "/repo", pid: 110, isSelf: false });
		expect(body.sessions[0].transcript).toEndWith("01a0-session.jsonl");
	});

	test("include_self and all widen the listing", async () => {
		const { main } = transcriptFixture();
		const { body } = await json(fakeHost(main), { action: "list", all: true, include_self: true });
		expect(body.sessions.map((row: { block: string; kind: string }) => `${row.block}:${row.kind}`)).toEqual([
			"10:omp",
			"11:omp",
			"20:claude",
		]);
	});

	test("lists everything when the caller is not inside Tern", async () => {
		const { main } = transcriptFixture();
		const { body } = await json(fakeHost(main, {}), { action: "list" });
		expect(body.scope).toBe("all");
		expect(body.sessions).toHaveLength(3);
	});
});

describe("tern_agents digest", () => {
	test("returns only user and assistant text, newest last, within the limit", async () => {
		const { main } = transcriptFixture();
		const { body } = await json(fakeHost(main), { action: "digest", block: "11", messages: 2 });
		expect(body.title).toBe("Fix the build");
		expect(body.model).toBe("provider/model-a");
		expect(body.messages.map((message: { text: string }) => message.text)).toEqual(["visible answer", "second ask"]);
		const text = JSON.stringify(body);
		for (const hidden of ["private reasoning", "secret", "tool output"]) expect(text).not.toContain(hidden);
	});

	test("points non-omp agents at a screen capture instead of guessing a format", async () => {
		const { main } = transcriptFixture();
		const { result } = await json(fakeHost(main), { action: "digest", block: "20" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("tern_state action=capture block=20");
	});
});
