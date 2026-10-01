import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ExecResult, Params, TernExec, ToolRegistration, ToolResult } from "./types";

export const OUTPUT_LIMIT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Where the macOS app bundle keeps the CLI; Tern does not put it on PATH. */
export const APP_BINARY = "/Applications/Tern.app/Contents/MacOS/tern";

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** `TERN_BIN`, then `tern` on PATH, then the app bundle, then a bare `tern` for the error message. */
export function resolveTernBinary(env: NodeJS.ProcessEnv, executable: (path: string) => boolean = isExecutable): string {
	const configured = env.TERN_BIN?.trim();
	if (configured) return configured;
	for (const directory of (env.PATH ?? "").split(delimiter)) {
		if (directory && executable(join(directory, "tern"))) return join(directory, "tern");
	}
	return executable(APP_BINARY) ? APP_BINARY : "tern";
}

export function clipOutput(value: string): string {
	if (value.length <= OUTPUT_LIMIT) return value;
	return `${value.slice(0, OUTPUT_LIMIT)}\n… output truncated at ${OUTPUT_LIMIT} characters`;
}

export function text(value: string, details: Record<string, unknown>, isError = false): ToolResult {
	return { content: [{ type: "text", text: clipOutput(value) }], details, ...(isError ? { isError: true } : {}) };
}

export interface RunOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export async function runTern(
	host: TernExec & { env: NodeJS.ProcessEnv },
	args: string[],
	options: RunOptions = {},
): Promise<ExecResult> {
	return host.exec(resolveTernBinary(host.env), args, {
		signal: options.signal,
		timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	});
}

export function failureText(action: string, result: ExecResult): string {
	const stderr = result.stderr.trim();
	const stdout = result.stdout.trim();
	if (result.killed) return `tern ${action} was terminated before it answered${stderr ? `:\n${stderr}` : ""}`;
	let reason = stderr || stdout || "tern returned no diagnostic output";
	if (/ENOENT|not found/i.test(reason) && !/no block|no session/i.test(reason)) {
		reason += `\nInstall Tern, put its CLI on PATH, or set TERN_BIN (macOS app CLI: ${APP_BINARY}).`;
	} else if (/no session daemon/i.test(reason)) {
		reason += "\nTern is not running; open the Tern app first.";
	}
	return `tern ${action} failed with exit code ${result.code}:\n${reason}`;
}

/** Run one Tern CLI command and report stdout, or the failure, as a tool result. */
export async function executeTern(
	host: TernExec & { env: NodeJS.ProcessEnv },
	action: string,
	args: string[],
	options: RunOptions = {},
): Promise<ToolResult> {
	const details = { action };
	try {
		const result = await runTern(host, args, options);
		if (result.code !== 0 || result.killed) {
			return text(failureText(action, result), { ...details, exitCode: result.code }, true);
		}
		return text(result.stdout.replace(/\s+$/, "") || `tern ${action} completed.`, { ...details, exitCode: 0 });
	} catch (error) {
		return text(`tern ${action} failed: ${error instanceof Error ? error.message : String(error)}`, details, true);
	}
}

/** Wrap a pure argument builder: validation errors become tool errors, never exceptions. */
export function makeExecute(
	host: TernExec & { env: NodeJS.ProcessEnv },
	build: (params: Params, env: NodeJS.ProcessEnv) => string[],
	timeoutMs?: (params: Params) => number,
): ToolRegistration["execute"] {
	return async (_id, params, signal) => {
		const action = typeof params.action === "string" ? params.action : "invalid";
		let args: string[];
		try {
			args = build(params, host.env);
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error), { action }, true);
		}
		return executeTern(host, action, args, { signal, timeoutMs: timeoutMs?.(params) });
	};
}
