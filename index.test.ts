import { describe, expect, test } from "bun:test";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import type { TSchema } from "@sinclair/typebox";
import {
	buildEventsArgs,
	buildLayoutArgs,
	buildTerminalArgs,
	registerTernTools,
	resolveTernBinary,
	selectEvents,
} from "./src/index";
import type { ExecResult, ToolRegistration } from "./src/types";

type Call = { command: string; args: string[]; timeout?: number };
type Responder = (call: Call) => Partial<ExecResult>;

function harness(respond: Responder, env: NodeJS.ProcessEnv = {}) {
	const calls: Call[] = [];
	const tools = new Map<string, ToolRegistration>();
	registerTernTools(
		{
			exec: async (command, args, options) => {
				const call = { command, args, timeout: options?.timeout };
				calls.push(call);
				return { stdout: "", stderr: "", code: 0, killed: false, ...respond(call) };
			},
			registerTool: (tool) => tools.set(tool.name, tool),
		},
		{ TERN_BIN: "/opt/tern", SHELL: "/bin/zsh", ...env },
	);
	const run = (name: string, params: Record<string, unknown>) => tools.get(name)!.execute("call", params);
	return { calls, tools, run };
}

const TREE = {
	sessions: [
		{ id: 4, name: "Default", tabs: [{ number: 1, blocks: [{ id: 10, exited: null }, { id: 11, exited: null }] }] },
		{ id: 7, name: "scratch", tabs: [{ number: 1, blocks: [{ id: 20, exited: null }] }] },
	],
};

describe("tool schemas", () => {
	test("accept a valid call and reject an unknown action for every tool", () => {
		const { tools } = harness(() => ({}));
		const valid: Record<string, Record<string, unknown>> = {
			tern_agents: { action: "list" },
			tern_state: { action: "capture", block: "10", lines: 50 },
			tern_layout: { action: "split", block: "10", direction: "right" },
			tern_terminal: { action: "wait", block: "10", until: "prompt" },
			tern_events: { duration_ms: 500 },
		};
		expect([...tools.keys()].sort()).toEqual(Object.keys(valid).sort());
		for (const [name, params] of Object.entries(valid)) {
			const schema = TypeCompiler.Compile(tools.get(name)!.parameters as unknown as TSchema);
			expect(schema.Check(params)).toBe(true);
			if (name !== "tern_events") expect(schema.Check({ ...params, action: "explode" })).toBe(false);
		}
	});
});

describe("resolveTernBinary", () => {
	const executable = (present: string[]) => (path: string) => present.includes(path);

	test("prefers TERN_BIN, then PATH, then the macOS app bundle", () => {
		const app = "/Applications/Tern.app/Contents/MacOS/tern";
		expect(resolveTernBinary({ TERN_BIN: "/x/tern", PATH: "/usr/bin" }, executable(["/usr/bin/tern"]))).toBe("/x/tern");
		expect(resolveTernBinary({ PATH: "/a:/usr/bin" }, executable(["/usr/bin/tern", app]))).toBe("/usr/bin/tern");
		expect(resolveTernBinary({ PATH: "/a" }, executable([app]))).toBe(app);
		expect(resolveTernBinary({ PATH: "/a" }, executable([]))).toBe("tern");
	});
});

describe("tern_layout", () => {
	test("launches a split command through the login shell after --json and --", () => {
		expect(
			buildLayoutArgs(
				{ action: "split", block: "10", direction: "down", cwd: "/repo", keep_open: true, command: "bun dev" },
				{ SHELL: "/bin/zsh" },
			),
		).toEqual(["split", "10", "down", "--json", "--cwd", "/repo", "--keep-open", "--", "/bin/zsh", "-lc", "bun dev"]);
	});

	test("rejects targets Tern would parse as options", () => {
		expect(() => buildLayoutArgs({ action: "close", block: "--all" }, {})).toThrow('must not start with "-"');
		expect(() => buildLayoutArgs({ action: "split", block: "10", direction: "left" }, {})).toThrow("direction");
	});

	test("refuses to close the caller's own pane without calling tern close", async () => {
		const { calls, run } = harness(() => ({}), { TERN_PANE: "10" });
		const result = await run("tern_layout", { action: "close", block: "10" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("own pane");
		expect(calls).toEqual([]);
	});

	test("refuses to kill the caller's session but kills another", async () => {
		const respond: Responder = ({ args }) => (args[0] === "ls" ? { stdout: JSON.stringify(TREE) } : {});
		const { calls, run } = harness(respond, { TERN_PANE: "11" });

		const own = await run("tern_layout", { action: "kill_session", session: "Default" });
		expect(own.isError).toBe(true);
		expect(calls.some((call) => call.args[0] === "kill")).toBe(false);

		const other = await run("tern_layout", { action: "kill_session", session: "scratch" });
		expect(other.isError).toBeUndefined();
		expect(calls.at(-1)!.args).toEqual(["kill", "session", "scratch"]);
	});
});

describe("tern_terminal", () => {
	test("splits key combos and rejects malformed ones", () => {
		expect(buildTerminalArgs({ action: "send_keys", block: "10", keys: "ctrl+c  enter" })).toEqual([
			"send",
			"10",
			"keys",
			"ctrl+c",
			"enter",
		]);
		expect(() => buildTerminalArgs({ action: "send_keys", block: "10", keys: "ctrl+c; rm" })).toThrow("invalid key combo");
	});

	test("reports a wait timeout as an answer, not a failure", async () => {
		const { calls, run } = harness(() => ({ code: 124, stderr: "tern wait: the session daemon did not answer" }));
		const result = await run("tern_terminal", { action: "wait", block: "10", until: "prompt", timeout_seconds: 2 });
		expect(result.isError).toBeUndefined();
		expect(result.details.timedOut).toBe(true);
		expect(calls[0].timeout).toBe(7_000);
	});

	test("reports the program's nonzero exit status as an answer", async () => {
		const { run } = harness(() => ({ code: 3 }));
		const result = await run("tern_terminal", { action: "wait", block: "10" });
		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain("exit status 3");
	});

	test("reports an unknown block as a failure", async () => {
		const { run } = harness(() => ({ code: 1, stderr: "tern wait: no block is called `99`" }));
		const result = await run("tern_terminal", { action: "wait", block: "99" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("no block is called");
	});
});

describe("tern_events", () => {
	const stream = [
		'{"event":"client_connected","conn":1}',
		'{"event":"pane_spawned","pane":10,"by":1}',
		'{"event":"title_changed","pane":20,"title":"x"}',
		"not json",
	].join("\n");

	test("drops CLI churn and narrows to one block", () => {
		expect(selectEvents(stream, undefined, false)).toHaveLength(2);
		expect(selectEvents(stream, "20", false)).toEqual(['{"event":"title_changed","pane":20,"title":"x"}']);
		expect(selectEvents(stream, undefined, true)).toHaveLength(3);
	});

	test("validates filter kinds", () => {
		expect(buildEventsArgs({ filter: "pane_spawned, title_changed" })).toEqual([
			"events",
			"--filter",
			"pane_spawned,title_changed",
		]);
		expect(() => buildEventsArgs({ filter: "pane;rm" })).toThrow("invalid event kind");
	});

	test("treats the window closing as the normal end of collection", async () => {
		const { run } = harness(() => ({ stdout: stream, code: 143, killed: true }));
		const result = await run("tern_events", { duration_ms: 200 });
		expect(result.isError).toBeUndefined();
		expect(result.details.count).toBe(2);
	});
});

describe("tern_state", () => {
	test("keeps the last lines of a capture and says how many were omitted", async () => {
		const screen = Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n");
		const { calls, run } = harness(() => ({ stdout: `${screen}\n\n\n` }));
		const result = await run("tern_state", { action: "capture", block: "10", scrollback: true, lines: 3 });
		expect(calls[0].args).toEqual(["capture", "10", "--scrollback"]);
		expect(result.content[0].text).toBe("[7 earlier lines omitted; raise lines to see more]\nline 7\nline 8\nline 9");
	});
});
