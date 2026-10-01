import type { Params, TernExec, ToolRegistration } from "../types";
import { executeTern, failureText, runTern, text } from "../exec";
import { actionOf, optionalEnum, optionalInteger, requiredString, ternTarget } from "../validation";

export const TERMINAL_ACTIONS = ["send_text", "paste", "send_keys", "run", "wait"] as const;
export const WAIT_CONDITIONS = ["exit", "prompt", "idle"] as const;
/** Modifiers joined by `+`, ending in one key: a name such as `enter`/`f5`, or a single punctuation key. */
const KEY_COMBO = /^(?:[A-Za-z][A-Za-z0-9]*\+)*(?:[A-Za-z0-9]+|[.,;'/\\`=\-[\]])$/;
const DEFAULT_WAIT_SECONDS = 30;
/** `tern wait` exits 124 when its own timeout runs out. */
export const WAIT_TIMEOUT_EXIT = 124;

export function buildTerminalArgs(params: Params): string[] {
	const action = actionOf(params);
	const block = ternTarget(params, "block", true);
	switch (action) {
		case "send_text":
			return ["send", block, "text", requiredString(params, "text")];
		case "paste":
			return ["send", block, "paste", requiredString(params, "text")];
		case "send_keys": {
			const combos = requiredString(params, "keys").trim().split(/\s+/);
			const invalid = combos.find((combo) => !KEY_COMBO.test(combo));
			if (invalid) throw new Error(`invalid key combo "${invalid}"; use names like enter, escape, tab, ctrl+c`);
			return ["send", block, "keys", ...combos];
		}
		case "run":
			return ["run", block, requiredString(params, "command")];
		case "wait": {
			const until = optionalEnum(params, "until", WAIT_CONDITIONS) ?? "exit";
			const idleMs = optionalInteger(params, "idle_ms", 50, 600_000);
			if (idleMs !== undefined && until !== "idle") throw new Error("idle_ms only applies when until is idle");
			const condition = until === "idle" ? `idle=${idleMs ?? 2000}` : until;
			const seconds = optionalInteger(params, "timeout_seconds", 1, 600) ?? DEFAULT_WAIT_SECONDS;
			return ["wait", block, "--until", condition, "--timeout", String(seconds)];
		}
		default:
			throw new Error(`unsupported tern_terminal action: ${action}`);
	}
}

export function makeTerminalExecute(host: TernExec & { env: NodeJS.ProcessEnv }): ToolRegistration["execute"] {
	return async (_id, params, signal) => {
		const action = typeof params.action === "string" ? params.action : "invalid";
		let args: string[];
		try {
			args = buildTerminalArgs(params);
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error), { action }, true);
		}
		if (action !== "wait") return executeTern(host, action, args, { signal });

		// `tern wait` reports the program's own status for --until exit, so a
		// nonzero code is an answer, not a failure. Only a diagnostic on stderr
		// (unknown block, no daemon) outside the timeout code is a tool error.
		const seconds = Number(args[args.length - 1]);
		try {
			const result = await runTern(host, args, { signal, timeoutMs: (seconds + 5) * 1000 });
			const details = { action, exitCode: result.code, condition: args[3] };
			if (result.code === WAIT_TIMEOUT_EXIT) {
				return text(`condition ${args[3]} not reached within ${seconds}s; the block is still running`, {
					...details,
					timedOut: true,
				});
			}
			if (result.killed || (result.code !== 0 && result.stderr.trim())) {
				return text(failureText(action, result), details, true);
			}
			const status = args[3] === "exit" ? ` with exit status ${result.code}` : "";
			return text(`condition ${args[3]} reached${status}`, { ...details, timedOut: false });
		} catch (error) {
			return text(`tern wait failed: ${error instanceof Error ? error.message : String(error)}`, { action }, true);
		}
	};
}
