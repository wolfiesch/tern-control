import type { ExtensionAPI, ToolContext } from "./types";
import { createTypeBoxAdapter } from "./schema";
import { fallbackExec } from "./host";
import { CAPTURE_FORMATS, makeStateExecute, STATE_ACTIONS } from "./tools/state";
import { LAYOUT_ACTIONS, makeLayoutExecute, MOVE_POSITIONS, PIP_CORNERS } from "./tools/layout";
import { makeTerminalExecute, TERMINAL_ACTIONS, WAIT_CONDITIONS } from "./tools/terminal";
import { makeEventsExecute } from "./tools/events";
import { makeAgentsExecute } from "./tools/agents";

export { fallbackExec } from "./host";
export { executeTern, resolveTernBinary } from "./exec";
export { buildStateArgs } from "./tools/state";
export { buildLayoutArgs } from "./tools/layout";
export { buildTerminalArgs } from "./tools/terminal";
export { buildEventsArgs, selectEvents } from "./tools/events";
export { agentKind, discoverAgents, makeAgentsExecute, pickTranscript, transcriptDigest } from "./tools/agents";

export default function ternExtension(pi: ExtensionAPI): void {
	registerTernTools(pi, process.env);
}

/** Register every tool against an explicit environment (the caller's `TERN_PANE`, `PATH`, `SHELL`). */
export function registerTernTools(pi: ExtensionAPI, env: NodeJS.ProcessEnv): void {
	const host: ToolContext = {
		exec: typeof pi.exec === "function" ? pi.exec.bind(pi) : fallbackExec,
		env,
	};
	const z = pi.zod ?? createTypeBoxAdapter();
	const block = z
		.string()
		.optional()
		.describe("Tern block: numeric id (preferred), @focused, a title, a program name, or SESSION/BLOCK");

	if (Boolean(pi.zod) && typeof pi.setLabel === "function") pi.setLabel("Tern Control");

	pi.registerTool({
		name: "tern_agents",
		label: "Tern Agent Sessions",
		description:
			"Discover the coding-agent sessions running live in Tern panes (Oh My Pi, Pi, Claude Code, Codex, OpenCode, Gemini, Amp, Cursor, Kiro, and others) with exact session, tab, block, cwd and pid. list defaults to the caller's own Tern session and excludes the calling pane. digest returns the recent user and assistant messages of one Oh My Pi or Pi block, read from the transcript that block's process holds open; never thinking or tool payloads.",
		parameters: z.object({
			action: z.enum(["list", "digest"]).describe("Agent-session operation"),
			all: z.boolean().optional().describe("List agents in every Tern session, not only the caller's"),
			include_self: z.boolean().optional().describe("Keep the calling pane in list output; defaults to false"),
			block: z.string().optional().describe("Block id of the agent to digest (digest)"),
			messages: z.number().int().min(1).max(20).optional().describe("Recent messages to include; default 8 (digest)"),
		}),
		loadMode: "discoverable",
		approval: "read",
		strict: true,
		execute: makeAgentsExecute(host),
	});

	pi.registerTool({
		name: "tern_state",
		label: "Tern State",
		description:
			"Inspect live Tern: ls (sessions, tabs and blocks as JSON), inspect (that plus panes and connected clients), process (a block's child and foreground process with cwd and argv), and capture (a block's screen text, optionally with scrollback, ANSI or HTML). Inspect before mutating layout or sending input.",
		parameters: z.object({
			action: z.enum(STATE_ACTIONS).describe("Read-only Tern operation"),
			block,
			scrollback: z.boolean().optional().describe("Include scrollback (capture)"),
			format: z.enum(CAPTURE_FORMATS).optional().describe("Capture format; default text (capture)"),
			lines: z.number().int().min(1).max(5000).optional().describe("Keep the last N captured lines; default 200 (capture)"),
		}),
		loadMode: "discoverable",
		approval: "read",
		strict: true,
		execute: makeStateExecute(host),
	});

	pi.registerTool({
		name: "tern_layout",
		label: "Tern Layout",
		description:
			"Arrange Tern without stealing focus: new_session, new_tab and split (each returns the new session/tab/block ids, optionally launching a command through the login shell), move, pip, dock, rename, keep_open, and explicit focus, close and kill_session. A block whose command succeeds closes unless keep_open is set. close and kill_session refuse the calling agent's own pane and session. Verify with tern_state afterward.",
		parameters: z.object({
			action: z.enum(LAYOUT_ACTIONS).describe("Layout operation"),
			block,
			session: z.string().optional().describe("Session name or id (new_tab target, rename, kill_session)"),
			name: z.string().optional().describe("New session name (new_session) or replacement name (rename)"),
			direction: z
				.enum(["left", "right", "up", "down"])
				.optional()
				.describe("split: right or down; dock: edge to dock the picture-in-picture into"),
			cwd: z.string().optional().describe("Working directory for new_session, new_tab or split"),
			command: z.string().optional().describe("Command to launch in the new block, run via the user's login shell"),
			keep_open: z.boolean().optional().describe("Keep the new block open after its command exits"),
			position: z.enum(MOVE_POSITIONS).optional().describe("move destination relative to target_block, a tab number, or a new tab"),
			target_block: z.string().optional().describe("Reference block for move, or the block a pip floats over"),
			tab: z.number().int().min(1).max(1000).optional().describe("Tab number (move with position tab)"),
			corner: z.enum(PIP_CORNERS).optional().describe("pip corner"),
			enabled: z.boolean().optional().describe("keep_open on or off"),
		}),
		loadMode: "discoverable",
		approval: "exec",
		strict: true,
		execute: makeLayoutExecute(host),
	});

	pi.registerTool({
		name: "tern_terminal",
		label: "Tern Terminal Input",
		description:
			"Drive one explicit Tern block: send_text (typed, no Enter), paste (bracketed paste), send_keys (space-separated combos such as enter, escape, ctrl+c), run (types a command and Enter into a shell at its prompt), and wait (until exit, prompt, or idle; reports the program's exit status, or that the timeout passed). Read the block with tern_state capture before and after sending input.",
		parameters: z.object({
			action: z.enum(TERMINAL_ACTIONS).describe("Terminal operation"),
			block: z.string().describe("Explicit target block"),
			text: z.string().optional().describe("Text to type or paste (send_text, paste)"),
			keys: z.string().optional().describe("Space-separated key combos (send_keys)"),
			command: z.string().optional().describe("Shell command line to run (run)"),
			until: z.enum(WAIT_CONDITIONS).optional().describe("wait condition; default exit"),
			idle_ms: z.number().int().min(50).max(600000).optional().describe("Quiet period for until idle; default 2000"),
			timeout_seconds: z.number().int().min(1).max(600).optional().describe("wait limit; default 30"),
		}),
		loadMode: "discoverable",
		approval: "exec",
		strict: true,
		execute: makeTerminalExecute(host),
	});

	pi.registerTool({
		name: "tern_events",
		label: "Tern Events",
		description:
			"Collect Tern daemon events for a bounded window (default 3 s, max 30 s) as JSON lines: pane_spawned, pane_closed, title_changed, cwd_changed, layout_changed and others. CLI connect/leave churn is dropped unless include_clients is set; block narrows to one numeric block id.",
		parameters: z.object({
			filter: z.string().optional().describe("Comma-separated event kinds, passed to tern events --filter"),
			block: z.string().optional().describe("Only events for this numeric block id"),
			duration_ms: z.number().int().min(100).max(30000).optional().describe("Collection window; default 3000"),
			include_clients: z.boolean().optional().describe("Keep client_connected/client_left events"),
		}),
		loadMode: "discoverable",
		approval: "read",
		strict: true,
		execute: makeEventsExecute(host),
	});
}
