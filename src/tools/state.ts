import type { Params, TernExec, ToolRegistration } from "../types";
import { executeTern, text } from "../exec";
import { actionOf, optionalBoolean, optionalEnum, optionalInteger, ternTarget } from "../validation";

export const STATE_ACTIONS = ["ls", "inspect", "process", "capture"] as const;
export const CAPTURE_FORMATS = ["text", "ansi", "html"] as const;
const DEFAULT_CAPTURE_LINES = 200;

export function buildStateArgs(params: Params): string[] {
	const action = actionOf(params);
	switch (action) {
		case "ls":
		case "inspect":
			return [action, "--json"];
		case "process":
			return ["process", ternTarget(params, "block", true), "--json"];
		case "capture": {
			const args = ["capture", ternTarget(params, "block", true)];
			const format = optionalEnum(params, "format", CAPTURE_FORMATS) ?? "text";
			if (format !== "text") args.push(`--${format}`);
			if (optionalBoolean(params, "scrollback")) args.push("--scrollback");
			return args;
		}
		default:
			throw new Error(`unsupported tern_state action: ${action}`);
	}
}

/** Keep the last `lines` lines of a capture, dropping the blank rows below the cursor. */
export function tailLines(output: string, lines: number): { text: string; omitted: number } {
	const rows = output.replace(/\s+$/, "").split("\n");
	const omitted = Math.max(0, rows.length - lines);
	return { text: rows.slice(omitted).join("\n"), omitted };
}

export function makeStateExecute(host: TernExec & { env: NodeJS.ProcessEnv }): ToolRegistration["execute"] {
	return async (_id, params, signal) => {
		const action = typeof params.action === "string" ? params.action : "invalid";
		let args: string[];
		let lines: number;
		try {
			args = buildStateArgs(params);
			lines = optionalInteger(params, "lines", 1, 5000) ?? DEFAULT_CAPTURE_LINES;
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error), { action }, true);
		}
		const result = await executeTern(host, action, args, { signal });
		if (action !== "capture" || result.isError) return result;
		const tail = tailLines(result.content[0].text, lines);
		const note = tail.omitted > 0 ? `[${tail.omitted} earlier lines omitted; raise lines to see more]\n` : "";
		return text(`${note}${tail.text}`, { ...result.details, omittedLines: tail.omitted });
	};
}
