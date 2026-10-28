import {
	createModelRegistryAdapter,
	type ModelRegistryAdapter,
	type RoutingRegistrySource,
} from "../../core/routing.ts";

/**
 * 把 Pi 模型注册表适配成路由层的最小接口：只做精确查找与鉴权查询，
 * 不读取模型能力、不夹取思考级别。
 */
export function wrapPiModelRegistry(
	registry: RoutingRegistrySource,
): ModelRegistryAdapter {
	return createModelRegistryAdapter(registry);
}
