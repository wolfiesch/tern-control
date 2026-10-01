import { execFile } from "node:child_process";
import type { ExecResult } from "./types";

export function fallbackExec(
	command: string,
	args: string[],
	options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
): Promise<ExecResult> {
	return new Promise<ExecResult>((resolve) => {
		execFile(
			command,
			args,
			{
				signal: options?.signal,
				timeout: options?.timeout,
				cwd: options?.cwd,
				maxBuffer: 10 * 1024 * 1024,
			},
			(error, stdout, stderr) => {
				const stdoutStr = typeof stdout === "string" ? stdout : String(stdout ?? "");
				const stderrStr = typeof stderr === "string" ? stderr : String(stderr ?? "");
				if (error) {
					const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
					const killed = Boolean((error as { killed?: boolean }).killed || (error as { signal?: string }).signal);
					resolve({
						stdout: stdoutStr,
						stderr: stderrStr,
						code,
						killed,
					});
				} else {
					resolve({
						stdout: stdoutStr,
						stderr: stderrStr,
						code: 0,
						killed: false,
					});
				}
			},
		);
	});
}
