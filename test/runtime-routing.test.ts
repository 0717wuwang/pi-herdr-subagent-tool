import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createModelRegistryAdapter,
	parseExactModelRef,
	resolveRuntimePlan,
	resolveRuntimePlans,
	RuntimeResolutionError,
	type RoutingModel,
} from "../maestro/core/routing.ts";
import { wrapPiModelRegistry } from "../maestro/adapters/pi/model-registry.ts";
import type { ModelEntry } from "../maestro/core/config/model-config.ts";

const CONFIG_PATH = "/home/user/.pi/agent/herdr-agents/config.json";

const CATALOG: RoutingModel[] = [
	{ provider: "fake", id: "first" },
	{ provider: "fake", id: "second" },
	{ provider: "other", id: "fast" },
	{ provider: "other", id: "unauthed" },
];

/** 真实 SDK 适配器之上只替换目录与鉴权：路由不得查询能力或候选清单。 */
function registry(calls: string[] = []) {
	const byRef = new Map(CATALOG.map((m) => [`${m.provider}/${m.id}`, m]));
	const source = {
		find(provider: string, modelId: string) {
			calls.push(`find:${provider}/${modelId}`);
			return byRef.get(`${provider}/${modelId}`);
		},
		hasConfiguredAuth(candidate: { provider: string; id: string }) {
			calls.push(`auth:${candidate.provider}/${candidate.id}`);
			return candidate.id !== "unauthed";
		},
	};
	return wrapPiModelRegistry(source);
}

const options = { configPath: CONFIG_PATH };

describe("exact model references", () => {
	it("splits at the first slash and rejects incomplete references", () => {
		assert.deepEqual(parseExactModelRef("provider/model-id"), {
			provider: "provider",
			modelId: "model-id",
		});
		assert.deepEqual(parseExactModelRef("openrouter/vendor/model"), {
			provider: "openrouter",
			modelId: "vendor/model",
		});
		for (const invalid of ["", "model-only", "/model", "provider/", " /x"]) {
			assert.equal(parseExactModelRef(invalid), undefined, invalid);
		}
	});
});

describe("configured model validation", () => {
	it("applies the configured thinking level verbatim", () => {
		assert.deepEqual(
			resolveRuntimePlan({ model: "fake/first", thinking: "high" }, registry()),
			{
				provider: "fake",
				modelId: "first",
				model: "fake/first",
				thinking: "high",
			},
		);
	});

	it("omits thinking entirely when the entry does not configure one", () => {
		const plan = resolveRuntimePlan({ model: "fake/first" }, registry());
		assert.equal("thinking" in plan, false);
	});

	it("never invents a thinking level for a model that cannot reason", () => {
		// 旧实现会把继承的级别夹取成 off；新契约只是原样下发配置值。
		const plan = resolveRuntimePlan(
			{ model: "fake/first", thinking: "medium" },
			registry(),
		);
		assert.equal(plan.thinking, "medium");
	});

	it("queries only exact registry lookup and configured authentication", () => {
		const calls: string[] = [];
		resolveRuntimePlan(
			{ model: "fake/first", thinking: "low" },
			createModelRegistryAdapter({
				find: (provider: string, modelId: string) => {
					calls.push(`find:${provider}/${modelId}`);
					return { provider, id: modelId };
				},
				hasConfiguredAuth: () => {
					calls.push("auth");
					return true;
				},
			}),
		);
		assert.deepEqual(calls, ["find:fake/first", "find:fake/first", "auth"]);
	});

	it("rejects an unknown model without listing other registry entries", () => {
		assert.throws(
			() => resolveRuntimePlan({ model: "fake/missing" }, registry()),
			(error: Error) =>
				error instanceof RuntimeResolutionError &&
				error.message.includes('"fake/missing"') &&
				error.message.includes("not in the model registry") &&
				!error.message.includes("other/fast"),
		);
	});

	it("rejects a model without configured authentication", () => {
		assert.throws(
			() => resolveRuntimePlan({ model: "other/unauthed" }, registry()),
			/no configured authentication/,
		);
	});

	it("rejects a reference that is not exactly provider/model-id", () => {
		assert.throws(
			() => resolveRuntimePlan({ model: "model-only" }, registry()),
			/exact "provider\/model-id" reference/,
		);
	});
});

describe("candidate chains", () => {
	const chain: ModelEntry[] = [
		{ model: "fake/missing" },
		{ model: "fake/first", thinking: "high" },
		{ model: "other/fast" },
	];

	it("keeps declaration order and skips unusable candidates", () => {
		assert.deepEqual(resolveRuntimePlans(chain, registry(), options), [
			{
				provider: "fake",
				modelId: "first",
				model: "fake/first",
				thinking: "high",
			},
			{ provider: "other", modelId: "fast", model: "other/fast" },
		]);
	});

	it("reports every failing candidate when the whole chain is unusable", () => {
		assert.throws(
			() =>
				resolveRuntimePlans(
					[{ model: "fake/missing" }, { model: "other/unauthed" }],
					registry(),
					options,
				),
			(error: Error) =>
				error instanceof RuntimeResolutionError &&
				error.message.includes(CONFIG_PATH) &&
				/not in the model registry/.test(error.message) &&
				/no configured authentication/.test(error.message),
		);
	});

	it("rejects an empty candidate chain", () => {
		assert.throws(() => resolveRuntimePlans([], registry(), options), /empty/);
	});

	it("rejects a candidate chain for worktree subagents", () => {
		assert.throws(
			() =>
				resolveRuntimePlans(chain, registry(), {
					...options,
					worktree: true,
				}),
			/Model fallbacks are not supported for worktree subagents/,
		);
	});

	it("allows a single candidate for worktree subagents", () => {
		assert.deepEqual(
			resolveRuntimePlans([{ model: "fake/first" }], registry(), {
				...options,
				worktree: true,
			}),
			[{ provider: "fake", modelId: "first", model: "fake/first" }],
		);
	});
});
