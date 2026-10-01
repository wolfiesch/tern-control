import type { Params, TernExec, ToolRegistration } from "../types";
import { failureText, runTern, text } from "../exec";
import { optionalBoolean, optionalInteger, optionalString } from "../validation";

const EVENT_KIND = /^[a-z][a-z_]{0,63}$/;
const DEFAULT_DURATION_MS = 3_000;
/** Every CLI call (including this tool's own) connects and leaves; that churn hides real events. */
const CLIENT_EVENTS: Record<string, true> = { client_connected: true, client_left: true };

export function buildEventsArgs(params: Params): string[] {
	const filter = optionalString(params, "filter");
	if (filter === undefined) return ["events"];
	const kinds = filter.split(",").map((kind) => kind.trim());
	const invalid = kinds.find((kind) => !EVENT_KIND.test(kind));
	if (invalid !== undefined) throw new Error(`invalid event kind "${invalid}"; use names like pane_spawned,title_changed`);
	return ["events", "--filter", kinds.join(",")];
}

/**
 * Keep the event lines worth reporting: drop CLI connect/leave churn unless
 * asked, and narrow to one pane when `block` is a numeric id.
 */
export function selectEvents(output: string, block: string | undefined, includeClients: boolean): string[] {
	const kept: string[] = [];
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		let event: { event?: unknown; pane?: unknown };
		try {
			event = JSON.parse(line) as { event?: unknown; pane?: unknown };
		} catch {
			continue;
		}
		if (!includeClients && typeof event.event === "string" && CLIENT_EVENTS[event.event]) continue;
		if (block !== undefined && String(event.pane) !== block) continue;
		kept.push(line);
	}
	return kept;
}

export function makeEventsExecute(host: TernExec & { env: NodeJS.ProcessEnv }): ToolRegistration["execute"] {
	return async (_id, params, signal) => {
		const details: Record<string, unknown> = { action: "events" };
		let args: string[];
		let durationMs: number;
		let block: string | undefined;
		try {
			args = buildEventsArgs(params);
			durationMs = optionalInteger(params, "duration_ms", 100, 30_000) ?? DEFAULT_DURATION_MS;
			block = optionalString(params, "block");
			if (block !== undefined && !/^\d+$/.test(block)) throw new Error("block must be a numeric block id");
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error), details, true);
		}
		const includeClients = optionalBoolean(params, "include_clients") ?? false;
		try {
			// `tern events` streams until interrupted; the exec timeout is the bounded window.
			const result = await runTern(host, args, { signal, timeoutMs: durationMs });
			if (!result.killed && result.code !== 0) return text(failureText("events", result), details, true);
			const events = selectEvents(result.stdout, block, includeClients);
			const summary = `${events.length} event(s) in ${durationMs} ms`;
			return text(events.length ? `${events.join("\n")}\n[${summary}]` : `[${summary}]`, {
				...details,
				count: events.length,
				durationMs,
			});
		} catch (error) {
			return text(`tern events failed: ${error instanceof Error ? error.message : String(error)}`, details, true);
		}
	};
}
