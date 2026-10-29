// 路由层：把「config.jsonl 中配置的模型条目」校验成可执行的运行时计划。
// 这里只做精确校验（注册表命中 + 已配置鉴权），不推测、不列举、不回退父模型。
import type { ModelEntry } from "./config/model-config.ts";
import { isString } from "./config/type-guards.ts";
import { parseExactModelRef } from "./model-ref.ts";
import type { ThinkingLevel } from "./types.ts";

export type { ThinkingLevel } from "./types.ts";
export {
	isThinkingLevel,
	parseExactModelRef,
	THINKING_LEVELS,
} from "./model-ref.ts";

/** 注册表命中结果：只保留身份字段，模型元数据不参与路由决策。 */
export interface RoutingModel {
	provider: string;
	id: string;
}

export interface ModelRegistryAdapter {
	find(provider: string, modelId: string): RoutingModel | undefined;
	hasConfiguredAuth(model: { provider: string; id: string }): boolean;
}

export interface ResolvedRuntimePlan {
	provider: string;
	modelId: string;
	model: string;
	/** 用户配置的思考级别；未配置时不下发任何 thinking。 */
	thinking?: ThinkingLevel;
	observed?: {
		model?: string;
		thinking?: ThinkingLevel;
	};
	runtimeMismatch?: string;
}

export class RuntimeResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeResolutionError";
	}
}

// pi-herdr-agents extension
export interface RoutingRegistrySource {
	find(provider: string, modelId: string): any;
	hasConfiguredAuth?: (model: any) => boolean;
}

function toRoutingModel(value: any): RoutingModel | undefined {
	if (!value || !isString(value.provider) || !isString(value.id)) {
		return undefined;
	}
	return { provider: value.provider, id: value.id };
}

// pi-herdr-agents extension
export function createModelRegistryAdapter(
	registry: RoutingRegistrySource,
): ModelRegistryAdapter {
	return {
		find(provider, modelId) {
			return toRoutingModel(registry.find(provider, modelId));
		},
		hasConfiguredAuth(model) {
			const original = registry.find(model.provider, model.id);
			if (!original) return false;
			return registry.hasConfiguredAuth
				? registry.hasConfiguredAuth(original)
				: true;
		},
	};
}

/**
 * 校验单个配置条目：精确注册表命中 + 已配置鉴权。
 * 思考级别原样透传，不查询模型能力、不夹取。
 */
export function resolveRuntimePlan(
	entry: ModelEntry,
	registry: ModelRegistryAdapter,
): ResolvedRuntimePlan {
	const parsed = parseExactModelRef(entry.model);
	if (!parsed) {
		throw new RuntimeResolutionError(
			`Configured model ${JSON.stringify(entry.model)} must be an exact "provider/model-id" reference.`,
		);
	}
	const found = registry.find(parsed.provider, parsed.modelId);
	if (!found) {
		throw new RuntimeResolutionError(
			`Configured model ${JSON.stringify(entry.model)} is not in the model registry; configure an exact provider/model-id in config.jsonl (see docs/configuration.md).`,
		);
	}
	if (!registry.hasConfiguredAuth(found)) {
		throw new RuntimeResolutionError(
			`Configured model ${JSON.stringify(entry.model)} has no configured authentication.`,
		);
	}
	const plan: ResolvedRuntimePlan = {
		provider: found.provider,
		modelId: found.id,
		model: `${found.provider}/${found.id}`,
	};
	if (entry.thinking !== undefined) plan.thinking = entry.thinking;
	return plan;
}

export interface ResolveRuntimePlansOptions {
	/** 配置文件绝对路径，只用于错误信息。 */
	configPath: string;
	worktree?: boolean;
}

/**
 * 提前验证整条候选链：跳过不可用候选，返回按序可用的计划列表。
 * 全链不可用则抛错并逐条列出失败原因；此处不创建任何 Herdr 资源。
 */
export function resolveRuntimePlans(
	chain: readonly ModelEntry[],
	registry: ModelRegistryAdapter,
	options: ResolveRuntimePlansOptions,
): ResolvedRuntimePlan[] {
	if (options.worktree && chain.length > 1) {
		throw new RuntimeResolutionError(
			"Model fallbacks are not supported for worktree subagents.",
		);
	}
	const plans: ResolvedRuntimePlan[] = [];
	const failures: string[] = [];
	for (const entry of chain) {
		try {
			plans.push(resolveRuntimePlan(entry, registry));
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (plans.length > 0) return plans;
	const detail =
		failures.length > 0
			? failures.join("; ")
			: "the configured candidate list is empty";
	throw new RuntimeResolutionError(
		`No usable model for this subagent in ${options.configPath}. ${detail}`,
	);
}
