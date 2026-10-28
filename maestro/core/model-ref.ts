// 模型引用与思考级别的纯函数定义。
// 独立成文件，供配置解析与路由解析共用，避免配置层反向依赖路由层。
import type { ThinkingLevel } from "./types.ts";

export type { ThinkingLevel } from "./types.ts";

export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return THINKING_LEVELS.some((level) => level === value);
}

/** 解析精确的 `provider/model-id` 引用；不允许前缀、别名或猜测。 */
export function parseExactModelRef(
	reference: string,
): { provider: string; modelId: string } | undefined {
	const trimmed = reference.trim();
	const separator = trimmed.indexOf("/");
	if (separator <= 0 || separator === trimmed.length - 1) return undefined;
	const provider = trimmed.slice(0, separator).trim();
	const modelId = trimmed.slice(separator + 1).trim();
	return provider && modelId ? { provider, modelId } : undefined;
}
