import { isPlainObject, type JsonObject } from "./type-guards.ts";

/** 骨架生成结果：不包含 `models` 段，模型必须由用户自行配置。 */
export interface ConfigSkeletonPlan {
	/** 合并后的配置对象（已排除 `models` 段的新增）。 */
	config: JsonObject;
	/** 本次从示例补入的顶层段名。 */
	added: string[];
}

/**
 * 以示例配置为模板补齐缺失的顶层段，绝不写入 `models`：
 * 模型是用户资产，`/subagents-init` 只提供骨架。
 */
export function buildConfigSkeleton(
	existing: any,
	example: any,
): ConfigSkeletonPlan {
	if (existing !== undefined && !isPlainObject(existing)) {
		throw new Error("config.json must contain a JSON object");
	}
	if (!isPlainObject(example)) {
		throw new Error("config.json.example must contain a JSON object");
	}
	const config: JsonObject = { ...existing };
	const added: string[] = [];
	for (const [key, value] of Object.entries(example)) {
		if (key === "models") continue;
		if (Object.hasOwn(config, key)) continue;
		// SAFETY: 示例文件已通过 isPlainObject 校验，其值均为 JSON 值。
		config[key] = value as JsonObject[string];
		added.push(key);
	}
	return { config, added };
}
