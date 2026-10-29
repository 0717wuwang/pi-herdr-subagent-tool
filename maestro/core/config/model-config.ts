// 子代理模型的唯一来源：$PI_CODING_AGENT_DIR/herdr-agents/config.jsonl。
// 这里只做「读取与校验」：不做推测、不回退、不推荐候选，配置缺失即硬失败。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	isThinkingLevel,
	parseExactModelRef,
	THINKING_LEVELS,
} from "../model-ref.ts";
import type { ThinkingLevel } from "../types.ts";
import { isNonEmptyString, isRecord, isString } from "./type-guards.ts";
import { parseConfigJsonl } from "./config-source.ts";

/** 单个模型条目；`thinking` 缺省表示「不指定思考级别」。 */
export interface ModelEntry {
	model: string;
	thinking?: ThinkingLevel;
}

/** 有序候选轮询链：按序尝试，第一条可用者生效。 */
export type ModelChain = ModelEntry[];

/** 角色名到候选链的映射，只含配置显式声明的键。 */
export interface AgentModelChains {
	[agentName: string]: ModelChain | undefined;
}

/** 配置中的 `models` 段。 */
export interface ModelConfig {
	default?: ModelChain;
	agents: AgentModelChains;
}

/** 未配置模型（或链为空）时抛出的硬失败错误。 */
export class ModelNotConfiguredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelNotConfiguredError";
	}
}

const FORMAT_HINT =
	'expected {"models":{"default":{"model":"provider/model-id","thinking":"medium"},"agents":{"<agent>":{"model":"provider/model-id"} or [{"model":"..."},{"model":"..."}]}}}';

const MODEL_ENTRY_FIELDS = ["model", "thinking"];

function invalidModelConfig(source: string, message: string): Error {
	// 错误必须自解释：带配置绝对路径、字段名与迁移要点。
	return new Error(
		`Invalid subagent model config in ${source}: ${message}; ${FORMAT_HINT}. See docs/configuration.md.`,
	);
}

function assertKnownFields(record: any, field: string, source: string): void {
	const unknown = Object.keys(record).filter(
		(key) => !MODEL_ENTRY_FIELDS.includes(key),
	);
	if (unknown.length === 0) return;
	throw invalidModelConfig(
		source,
		`${field} has unknown field ${JSON.stringify(unknown[0])}; a model entry only accepts "model" and optional "thinking"`,
	);
}

function parseModelEntry(
	entry: any,
	field: string,
	source: string,
): ModelEntry {
	if (isString(entry)) {
		throw invalidModelConfig(
			source,
			`${field} uses the removed string form ${JSON.stringify(entry)}`,
		);
	}
	if (!isRecord(entry)) {
		throw invalidModelConfig(source, `${field} must be a model object`);
	}
	assertKnownFields(entry, field, source);
	const model = entry.model;
	if (!isNonEmptyString(model)) {
		throw invalidModelConfig(
			source,
			`${field}.model must be a non-empty "provider/model-id" string`,
		);
	}
	if (!parseExactModelRef(model)) {
		throw invalidModelConfig(
			source,
			`${field}.model ${JSON.stringify(model)} must be an exact "provider/model-id" reference`,
		);
	}
	const thinking = entry.thinking;
	if (thinking === undefined) return { model };
	if (!isString(thinking) || !isThinkingLevel(thinking)) {
		throw invalidModelConfig(
			source,
			`${field}.thinking must be one of: ${THINKING_LEVELS.join(", ")}`,
		);
	}
	return { model, thinking };
}

function parseModelChain(
	value: any,
	field: string,
	source: string,
): ModelChain {
	if (!Array.isArray(value)) return [parseModelEntry(value, field, source)];
	if (value.length === 0) {
		throw invalidModelConfig(
			source,
			`${field} must list at least one model entry`,
		);
	}
	return value.map((entry: any, index: number) =>
		parseModelEntry(entry, `${field}[${index}]`, source),
	);
}

function parseAgents(value: any, source: string): AgentModelChains {
	if (!isRecord(value)) {
		throw invalidModelConfig(source, `"models.agents" must be a JSON object`);
	}
	const agents: AgentModelChains = {};
	for (const name of Object.keys(value)) {
		agents[name] = parseModelChain(
			value[name],
			`models.agents.${name}`,
			source,
		);
	}
	return agents;
}

/** 解析 `models` 段。未配置时返回空配置；旧格式一律报错，不做兼容降级。 */
export function parseModelConfig(
	rawConfig: any,
	source = "config.jsonl",
): ModelConfig {
	if (!isRecord(rawConfig)) {
		throw invalidModelConfig(source, "config root must be a JSON object");
	}
	if (!Object.hasOwn(rawConfig, "models")) return { agents: {} };
	const models = rawConfig.models;
	if (!isRecord(models)) {
		throw invalidModelConfig(source, `"models" must be a JSON object`);
	}
	const unknown = Object.keys(models).filter(
		(key) => key !== "default" && key !== "agents",
	);
	if (unknown.length > 0) {
		const key = unknown[0];
		if (key === "tasks" || key === "tasksMeta") {
			throw invalidModelConfig(
				source,
				`"models.${key}" was removed; replace task categories with one ordered candidate array per agent`,
			);
		}
		throw invalidModelConfig(
			source,
			`"models" has unknown field ${JSON.stringify(key)}; only "default" and "agents" are accepted`,
		);
	}
	const agents = Object.hasOwn(models, "agents")
		? parseAgents(models.agents, source)
		: {};
	if (!Object.hasOwn(models, "default")) return { agents };
	return {
		default: parseModelChain(models.default, "models.default", source),
		agents,
	};
}

/** 读取持久配置中的 `models` 段；文件缺失视为未配置。 */
export function loadModelConfig(configDir: string): ModelConfig {
	const configPath = join(configDir, "config.jsonl");
	if (!existsSync(configPath)) return { agents: {} };
	let raw: any;
	try {
		raw = parseConfigJsonl(readFileSync(configPath, "utf8"), configPath);
	} catch (error) {
		throw invalidModelConfig(
			configPath,
			`file is not valid JSONL: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parseModelConfig(raw, configPath);
}

/**
 * 选出该代理要使用的候选链：`models.agents.<name>` 优先，其次 `models.default`。
 * 都没有时硬失败——绝不回退父模型或其它文件中的模型信息。
 */
export function selectModelChain(
	config: ModelConfig,
	agentName: string | undefined,
	configPath: string,
): ModelChain {
	const name = agentName?.trim();
	if (name) {
		// 只读配置自有属性，避免 constructor/toString 等继承属性被当作模型链。
		const chain = Object.hasOwn(config.agents, name)
			? config.agents[name]
			: undefined;
		if (chain && chain.length > 0) return chain;
	}
	// 同理：`default` 必须是配置里显式写入的键。
	if (Object.hasOwn(config, "default")) {
		const fallback = config.default;
		if (fallback && fallback.length > 0) return fallback;
	}
	const target = name
		? `models.agents.${name} or models.default`
		: "models.default";
	throw new ModelNotConfiguredError(
		`No model configured for ${name ? `agent ${JSON.stringify(name)} ` : "subagents "}in ${configPath}. ` +
			`Configure ${target}; ${FORMAT_HINT}. See docs/configuration.md.`,
	);
}
