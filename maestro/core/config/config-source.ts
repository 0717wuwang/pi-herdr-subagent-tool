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

/** JSONL 记录扫描状态：括号配平与字符串转义共同决定记录边界。 */
interface RecordScanner {
	inString: boolean;
	escaped: boolean;
	depth: number;
	started: boolean;
}

function createRecordScanner(): RecordScanner {
	return { inString: false, escaped: false, depth: 0, started: false };
}

/** 喂入一个字符并更新扫描状态。 */
function advanceRecordScanner(state: RecordScanner, ch: string): void {
	if (state.inString) {
		if (state.escaped) state.escaped = false;
		else if (ch === "\\") state.escaped = true;
		else if (ch === '"') state.inString = false;
		return;
	}
	if (ch === '"') state.inString = true;
	else if (ch === "{" || ch === "[" || ch === "(") state.depth++;
	else if (ch === "}" || ch === "]" || ch === ")") state.depth--;
}

/** 记录是否已配平收尾。 */
function isRecordComplete(state: RecordScanner): boolean {
	return state.started && !state.inString && state.depth === 0;
}

function splitJsonValues(text: string): string[] {
	const records: string[] = [];
	let state = createRecordScanner();
	let current = "";
	for (const ch of text) {
		if (!state.started) {
			if (/\s/.test(ch)) continue;
			state.started = true;
		}
		current += ch;
		advanceRecordScanner(state, ch);
		if (isRecordComplete(state)) {
			const record = current.trim();
			if (record) records.push(record);
			current = "";
			state = createRecordScanner();
		}
	}
	const rest = current.trim();
	if (rest) records.push(rest);
	return records;
}

/** 模板片段：记录之前的注释/空行原样保留；纯注释尾段没有记录。 */
export interface ConfigTemplateSegment {
	prefix: string[];
	record?: string;
}

/**
 * 把带注释的模板拆成「注释块 + 活跃 JSON 记录」序列，
 * 供生成配置时保留注释并按段替换取值。
 */
export function splitConfigTemplate(
	rawConfig: string,
): ConfigTemplateSegment[] {
	const segments: ConfigTemplateSegment[] = [];
	let prefix: string[] = [];
	let state = createRecordScanner();
	let current = "";
	for (const line of rawConfig.split(/\r?\n/)) {
		if (!state.started && current === "") {
			const trimmed = line.trimStart();
			if (trimmed === "" || trimmed.startsWith("#")) {
				prefix.push(line);
				continue;
			}
		}
		for (const ch of line) {
			state.started = true;
			current += ch;
			advanceRecordScanner(state, ch);
			if (isRecordComplete(state)) {
				segments.push({ prefix, record: current });
				prefix = [];
				current = "";
				state = createRecordScanner();
			}
		}
		if (current !== "") current += "\n";
	}
	if (current !== "") segments.push({ prefix, record: current.trimEnd() });
	else if (prefix.length > 0) segments.push({ prefix });
	return segments;
}

/**
 * Parse a config file as JSONL. Both the durable config.jsonl and the packaged
 * example are JSONL; the parser accepts `#` comments and a single JSON object.
 */
export function parseConfigFor(rawConfig: string, sourcePath: string): any {
	return parseConfigJsonl(rawConfig, sourcePath);
}
