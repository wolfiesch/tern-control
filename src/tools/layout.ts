import type { Params, TernExec, ToolRegistration } from "../types";
import { executeTern, runTern, text } from "../exec";
import {
	actionOf,
	optionalBoolean,
	optionalEnum,
	optionalInteger,
	optionalString,
	requiredString,
	ternTarget,
} from "../validation";

export const LAYOUT_ACTIONS = [
	"new_session",
	"new_tab",
	"split",
	"move",
	"pip",
	"dock",
	"rename",
	"focus",
	"keep_open",
	"close",
	"kill_session",
] as const;
export const MOVE_POSITIONS = ["below", "above", "left-of", "right-of", "tab", "new-tab"] as const;
export const PIP_CORNERS = ["tl", "tr", "bl", "br"] as const;
const DIRECTIONS = ["left", "right", "up", "down"] as const;

/**
 * Tern's LAUNCH suffix. A command runs through the user's login shell so it
 * sees the same PATH as an interactive pane; the Tern daemon itself starts
 * with the minimal launchd PATH.
 */
function launchArgs(params: Params, env: NodeJS.ProcessEnv): string[] {
	const args: string[] = [];
	const cwd = optionalString(params, "cwd");
	if (cwd !== undefined) args.push("--cwd", cwd);
	if (optionalBoolean(params, "keep_open")) args.push("--keep-open");
	const command = optionalString(params, "command");
	if (command !== undefined) {
		const shell = env.SHELL?.startsWith("/") ? env.SHELL : "/bin/sh";
		args.push("--", shell, "-lc", command);
	}
	return args;
}

export function buildLayoutArgs(params: Params, env: NodeJS.ProcessEnv): string[] {
	const action = actionOf(params);
	switch (action) {
		case "new_session": {
			const name = requiredString(params, "name");
			if (name.startsWith("-")) throw new Error('name must not start with "-"');
			return ["new", "session", name, "--json", ...launchArgs(params, env)];
		}
		case "new_tab": {
			const session = ternTarget(params, "session");
			return ["new", "tab", ...(session ? [session] : []), "--json", ...launchArgs(params, env)];
		}
		case "split": {
			const direction = optionalEnum(params, "direction", ["right", "down"] as const);
			if (!direction) throw new Error("direction is required for split (right or down)");
			return ["split", ternTarget(params, "block", true), direction, "--json", ...launchArgs(params, env)];
		}
		case "move": {
			const block = ternTarget(params, "block", true);
			const position = optionalEnum(params, "position", MOVE_POSITIONS);
			if (!position) throw new Error(`position is required for move (${MOVE_POSITIONS.join(", ")})`);
			if (position === "new-tab") return ["move", block, "new-tab"];
			if (position === "tab") {
				const tab = optionalInteger(params, "tab", 1, 1000);
				if (tab === undefined) throw new Error("tab is required when position is tab");
				return ["move", block, "tab", String(tab)];
			}
			return ["move", block, position, ternTarget(params, "target_block", true)];
		}
		case "pip": {
			const args = ["pip", ternTarget(params, "block", true)];
			const over = ternTarget(params, "target_block");
			if (over) args.push("--over", over);
			const corner = optionalEnum(params, "corner", PIP_CORNERS);
			if (corner) args.push("--corner", corner);
			return args;
		}
		case "dock": {
			const direction = optionalEnum(params, "direction", DIRECTIONS);
			return ["dock", ternTarget(params, "block", true), ...(direction ? [direction] : [])];
		}
		case "rename": {
			const target = ternTarget(params, "session") ?? ternTarget(params, "block");
			if (!target) throw new Error("rename needs session (to rename a session) or block (to rename its tab)");
			if (params.session !== undefined && params.block !== undefined) {
				throw new Error("rename takes session or block, not both");
			}
			return ["rename", target, requiredString(params, "name")];
		}
		case "focus":
			return ["focus", ternTarget(params, "block", true)];
		case "keep_open": {
			const enabled = optionalBoolean(params, "enabled");
			if (enabled === undefined) throw new Error("enabled is required for keep_open");
			return ["keep-open", ternTarget(params, "block", true), enabled ? "on" : "off"];
		}
		case "close":
			return ["close", ternTarget(params, "block", true)];
		case "kill_session":
			return ["kill", "session", ternTarget(params, "session", true)];
		default:
			throw new Error(`unsupported tern_layout action: ${action}`);
	}
}

interface LsTree {
	sessions?: Array<{ id: number; name: string; tabs?: Array<{ blocks?: Array<{ id: number }> }> }>;
}

/**
 * Refuse to close the caller's own pane or kill the session that holds it:
 * the agent would end itself mid-turn. Only a numeric id or exact session
 * name/id can be checked; titles and `@focused` resolve inside Tern.
 */
async function selfTargetReason(
	host: TernExec & { env: NodeJS.ProcessEnv },
	params: Params,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	const pane = host.env.TERN_PANE?.trim();
	if (!pane) return undefined;
	if (params.action === "close" && params.block === pane) {
		return `refusing to close block ${pane}: it is the calling agent's own pane`;
	}
	if (params.action !== "kill_session") return undefined;
	const listed = await runTern(host, ["ls", "--json"], { signal });
	if (listed.code !== 0) return undefined;
	let tree: LsTree;
	try {
		tree = JSON.parse(listed.stdout) as LsTree;
	} catch {
		return undefined;
	}
	const own = tree.sessions?.find((session) =>
		session.tabs?.some((tab) => tab.blocks?.some((block) => String(block.id) === pane)),
	);
	if (own && (params.session === own.name || params.session === String(own.id))) {
		return `refusing to kill session "${own.name}": it holds the calling agent's own pane`;
	}
	return undefined;
}

export function makeLayoutExecute(host: TernExec & { env: NodeJS.ProcessEnv }): ToolRegistration["execute"] {
	return async (_id, params, signal) => {
		const action = typeof params.action === "string" ? params.action : "invalid";
		let args: string[];
		try {
			args = buildLayoutArgs(params, host.env);
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error), { action }, true);
		}
		const refusal = await selfTargetReason(host, params, signal);
		if (refusal) return text(refusal, { action, refused: true }, true);
		return executeTern(host, action, args, { signal });
	};
}
