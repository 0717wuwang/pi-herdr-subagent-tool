import { splitConfigTemplate } from "./config-source.ts";
import {
	isPlainObject,
	type JsonObject,
	type JsonValue,
} from "./type-guards.ts";

/** 渲染结果：带注释的完整配置文本，以及本次由模板补入的顶层段名。 */
export interface ConfigDocumentPlan {
	/** 可直接写入 config.jsonl 的文本（保留 `#` 注释）。 */
	text: string;
	/** 模板补入的顶层段名；不含 `models`。 */
	added: string[];
}

/** 超过该长度的一行记录改用 2 空格缩进的多行形态。 */
const INLINE_RECORD_LIMIT = 100;

const PRESERVED_HEADER = [
	"# --- 保留的现有配置 --------------------------------------------------------",
	"# 以下段落来自你已有的 config.jsonl，模板中没有对应的活跃记录（例如 models），",
	"# 因此原样保留在文件末尾。注释行允许保留，修改后运行 /reload 生效。",
].join("\n");

function formatRecord(key: string, value: JsonValue | undefined): string {
	const inline = JSON.stringify({ [key]: value });
	if (inline.length <= INLINE_RECORD_LIMIT) return inline;
	return JSON.stringify({ [key]: value }, null, 2);
}

function parseTemplateRecord(rawRecord: string): JsonObject {
	let parsed: any;
	try {
		parsed = JSON.parse(rawRecord);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`config.jsonl.example has an unparsable record: ${detail}`);
	}
	if (!isPlainObject(parsed)) {
		throw new Error("config.jsonl.example records must be JSON objects");
	}
	return parsed;
}

/** 去掉首尾的空行，段间空行统一由渲染时的分隔符产生。 */
function trimBlankEdges(lines: string[]): string {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim() === "") start += 1;
	while (end > start && lines[end - 1].trim() === "") end -= 1;
	return lines.slice(start, end).join("\n");
}
/**
 * 以带注释的示例模板渲染持久配置：注释与示例全部保留，
 * 已存在的顶层段用现有取值替换，缺失段取模板默认值。
 * `models` 在模板里只有注释，因此绝不会被补成活跃记录；
 * 用户自己写的 `models` 原样保留在文件末尾。
 */
export function renderConfigDocument(
	existing: any,
	exampleRaw: string,
): ConfigDocumentPlan {
	if (existing !== undefined && !isPlainObject(existing)) {
		throw new Error("config.jsonl must contain a JSON object");
	}
	const config: JsonObject = isPlainObject(existing) ? { ...existing } : {};
	const added: string[] = [];
	const covered = new Set<string>();
	const blocks: string[] = [];
	for (const segment of splitConfigTemplate(exampleRaw)) {
		const prefix = trimBlankEdges(segment.prefix);
		if (segment.record === undefined) {
			if (prefix !== "") blocks.push(prefix);
			continue;
		}
		const record = parseTemplateRecord(segment.record);
		const keys = Object.keys(record);
		for (const key of keys) covered.add(key);
		const missing = keys.filter((key) => !Object.hasOwn(config, key));
		added.push(...missing);
		// 整段都缺失时保留示例原文，避免重新序列化破坏模板排版。
		const records =
			keys.length > 0 && missing.length === keys.length
				? [segment.record.trim()]
				: keys.map((key) =>
						formatRecord(
							key,
							Object.hasOwn(config, key) ? config[key] : record[key],
						),
					);
		const body = records.join("\n");
		blocks.push(prefix === "" ? body : `${prefix}\n${body}`);
	}
	const leftover = Object.keys(config).filter((key) => !covered.has(key));
	if (leftover.length > 0) {
		const preserved = Object.fromEntries(
			leftover.map((key) => [key, config[key]]),
		);
		blocks.push(`${PRESERVED_HEADER}\n${JSON.stringify(preserved, null, 2)}`);
	}
	return { text: `${blocks.join("\n\n")}\n`, added };
}
