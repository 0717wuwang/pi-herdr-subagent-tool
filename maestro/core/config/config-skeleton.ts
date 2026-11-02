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

/**
 * 保留区的稳定标记。刷新时只重写本行以上的模板段落，本行以下的内容逐字节
 * 保留，因此重复执行 init 不会破坏用户手写的记录与注释。
 */
export const PRESERVED_MARKER = "# --- 保留的现有配置";

const PRESERVED_HEADER_LINES = [
	`${PRESERVED_MARKER} --------------------------------------------------------`,
	"# 以下内容是模板不覆盖的部分（例如你自己的 models 条目），按原样保留在文件末尾。",
	"# 模板刷新只重写本行以上的段落；本行以下的内容逐字节保留，可以放心手写注释。",
	"# 修改后运行 /reload 生效。",
];

const PRESERVED_HEADER = PRESERVED_HEADER_LINES.join("\n");

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
/** 取回上次生成的保留区原文；没有标记时返回 undefined（首次刷新或手写配置）。 */
function splitPreservedRegion(raw: string): string | undefined {
	const lines = raw.split(/\r?\n/);
	const index = lines.findIndex((line) => line.startsWith(PRESERVED_MARKER));
	if (index < 0) return undefined;
	// 跳过固定的说明行，只取用户自己的内容；旧文件只有标记行时同样成立。
	let cursor = index + 1;
	while (
		cursor < lines.length &&
		PRESERVED_HEADER_LINES.includes(lines[cursor])
	) {
		cursor += 1;
	}
	return lines.slice(cursor).join("\n").trim();
}

/**
 * 以带注释的示例模板渲染持久配置：注释与示例全部保留，
 * 已存在的顶层段用现有取值替换，缺失段取模板默认值（`added` 只报这些新键）。
 * `models` 在模板里只有注释，因此绝不会被补成活跃记录；
 * 上一次生成的保留区原文用 `existingRaw` 传入时逐字节沿用，
 * 用户手写的记录与注释因此不会被重新序列化破坏。
 */
export function renderConfigDocument(
	existing: any,
	exampleRaw: string,
	existingRaw?: string,
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
		// 取值仍等于模板示例时保留示例原文，重新序列化会破坏模板排版。
		const untouched = keys.every(
			(key) =>
				Object.hasOwn(config, key) &&
				JSON.stringify(config[key]) === JSON.stringify(record[key]),
		);
		const records =
			keys.length > 0 && (missing.length === keys.length || untouched)
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
	const carried =
		existingRaw === undefined ? undefined : splitPreservedRegion(existingRaw);
	if (carried !== undefined) {
		// 保留区已存在：逐字节沿用，重复刷新因此是幂等的。
		blocks.push(`${PRESERVED_HEADER}\n${carried}`);
	} else {
		const leftover = Object.keys(config).filter((key) => !covered.has(key));
		if (leftover.length > 0) {
			const preserved = Object.fromEntries(
				leftover.map((key) => [key, config[key]]),
			);
			blocks.push(`${PRESERVED_HEADER}\n${JSON.stringify(preserved, null, 2)}`);
		}
	}
	return { text: `${blocks.join("\n\n")}\n`, added };
}
