import type { Params } from "./types";

export function actionOf(params: Params): string {
	return requiredString(params, "action");
}

export function requiredString(params: Params, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
	return value;
}

export function optionalString(params: Params, key: string): string | undefined {
	const value = params[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0) throw new Error(`${key} must be a non-empty string`);
	return value;
}

export function optionalBoolean(params: Params, key: string): boolean | undefined {
	const value = params[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
	return value;
}

export function optionalInteger(params: Params, key: string, minimum: number, maximum: number): number | undefined {
	const value = params[key];
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`${key} must be an integer from ${minimum} through ${maximum}`);
	}
	return value as number;
}

export function optionalEnum<T extends string>(params: Params, key: string, values: readonly T[]): T | undefined {
	const value = params[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new Error(`${key} must be one of ${values.join(", ")}`);
	}
	return value as T;
}

/**
 * A Tern target: a block id, `@focused`, a title, a program name, or
 * `SESSION/BLOCK`. Tern parses its own flags positionally, so a target that
 * starts with `-` would be read as an option instead of a name.
 */
export function ternTarget(params: Params, key: string, required: true): string;
export function ternTarget(params: Params, key: string, required?: false): string | undefined;
export function ternTarget(params: Params, key: string, required = false): string | undefined {
	const value = required ? requiredString(params, key) : optionalString(params, key);
	if (value === undefined) return undefined;
	if (value.startsWith("-")) throw new Error(`${key} must not start with "-"; Tern would read it as an option`);
	if (/[\r\n\0]/.test(value)) throw new Error(`${key} must be a single line`);
	return value.trim();
}
