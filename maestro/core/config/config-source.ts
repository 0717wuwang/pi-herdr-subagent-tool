import { readFileSync } from "node:fs";
import { isPlainObject } from "./type-guards.ts";

/**
 * Source of a parsed subagent config: where it was read from and the raw text.
 */
export interface ConfigSource {
	sourcePath: string;
	rawConfig: string;
}

/**
 * Read a subagent config file, falling back to the packaged example when the
 * local file does not exist. Throws the shared "Missing <label> config" error
 * when neither path exists.
 */
export function readConfigWithExampleFallback(
	configPath: string,
	examplePath: string,
	label: string,
): ConfigSource {
	try {
		return {
			sourcePath: configPath,
			rawConfig: readFileSync(configPath, "utf8"),
		};
	} catch (error) {
		// SAFETY: readFileSync only throws Node fs errors here, which carry code.
		const errno = error as NodeJS.ErrnoException;
		if (errno.code !== "ENOENT") throw error;
	}

	try {
		return {
			sourcePath: examplePath,
			rawConfig: readFileSync(examplePath, "utf8"),
		};
	} catch (error) {
		// SAFETY: see the preceding readFileSync error handling.
		const errno = error as NodeJS.ErrnoException;
		if (errno.code === "ENOENT") {
			throw new Error(
				`Missing ${label} config. Expected ${configPath} or ${examplePath}.`,
			);
		}
		throw error;
	}
}

/**
 * Parse config JSON, wrapping parse failures with the shared source path.
 */
export function parseConfigJson(rawConfig: string, sourcePath: string): any {
	try {
		return JSON.parse(rawConfig);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid JSON in subagent config ${sourcePath}: ${detail}`);
	}
}

/**
 * Parse a JSONL config file (the packaged template): `#` lines are comments,
 * the rest is a sequence of JSON objects merged in order (later keys win).
 * A record may span multiple lines; records are split at balanced top-level
 * values. A single JSON object is also accepted.
 */
export function parseConfigJsonl(rawConfig: string, sourcePath: string): any {
	const withoutComments = rawConfig
		.split(/\r?\n/)
		.map((line) => (line.trimStart().startsWith("#") ? "" : line))
		.join("\n");

	// Fast path: the whole file is one JSON value (single-object configs).
	const single = parseSingleJsonValue(withoutComments);
	if (single !== undefined && isPlainObject(single)) return single;

	const records = splitJsonValues(withoutComments);
	if (records.length === 0) {
		throw new Error(
			`Invalid JSONL in subagent config ${sourcePath}: no JSON records`,
		);
	}
	let merged: any = {};
	for (const record of records) {
		let parsed: any;
		try {
			parsed = JSON.parse(record);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Invalid JSONL record in subagent config ${sourcePath}: ${detail}`,
			);
		}
		if (!isPlainObject(parsed)) {
			throw new Error(
				`Invalid JSONL record in subagent config ${sourcePath}: each record must be a JSON object`,
			);
		}
		merged = { ...merged, ...parsed };
	}
	return merged;
}

function parseSingleJsonValue(text: string): any {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}


function splitJsonValues(text: string): string[] {
	const records: string[] = [];
	let current = "";
	let inString = false;
	let escaped = false;
	let depth = 0;
	let started = false;
	for (const ch of text) {
		if (!started) {
			if (/\s/.test(ch)) continue;
			started = true;
		}
		current += ch;
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{" || ch === "[" || ch === "(") depth++;
		else if (ch === "}" || ch === "]" || ch === ")") depth--;
		if (depth === 0 && started) {
			const record = current.trim();
			if (record) records.push(record);
			current = "";
			started = false;
		}
	}
	const rest = current.trim();
	if (rest) records.push(rest);
	return records;
}

/**
 * Parse a config file as JSONL. Both the durable config.jsonl and the packaged
 * example are JSONL; the parser accepts `#` comments and a single JSON object.
 */
export function parseConfigFor(rawConfig: string, sourcePath: string): any {
	return parseConfigJsonl(rawConfig, sourcePath);
}
