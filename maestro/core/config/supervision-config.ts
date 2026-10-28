import { join } from "node:path";
import { parseConfigJson, readConfigWithExampleFallback } from "./config-source.ts";
import { isBoolean, isFiniteNumber, isRecord } from "./type-guards.ts";

export interface SupervisionConfig {
	forcePolling: boolean;
	hangWarningMinutes: number;
}

function invalid(source: string, message: string): never {
	throw new Error(
		`Invalid subagent supervision config in ${source}: ${message}`,
	);
}

export function parseSupervisionConfig(
	rawConfig: any,
	source = "config.json",
): SupervisionConfig {
	if (!isRecord(rawConfig)) invalid(source, "root must be an object");
	if (!Object.hasOwn(rawConfig, "supervision")) {
		return { forcePolling: false, hangWarningMinutes: 15 };
	}
	if (!isRecord(rawConfig.supervision)) {
		invalid(source, "supervision must be an object");
	}
	const unsupported = Object.keys(rawConfig.supervision).filter(
		(key) => key !== "forcePolling" && key !== "hangWarningMinutes",
	);
	if (unsupported.length > 0) {
		invalid(
			source,
			`supervision has unsupported key(s): ${unsupported.join(", ")}`,
		);
	}
	const forcePolling = Object.hasOwn(rawConfig.supervision, "forcePolling")
		? rawConfig.supervision.forcePolling
		: false;
	if (!isBoolean(forcePolling)) {
		invalid(source, "supervision.forcePolling must be a boolean");
	}
	const hangWarningMinutes = Object.hasOwn(
		rawConfig.supervision,
		"hangWarningMinutes",
	)
		? rawConfig.supervision.hangWarningMinutes
		: 15;
	if (
		!isFiniteNumber(hangWarningMinutes) ||
		!Number.isInteger(hangWarningMinutes) ||
		hangWarningMinutes < 0
	) {
		invalid(
			source,
			"supervision.hangWarningMinutes must be a non-negative integer",
		);
	}
	return { forcePolling, hangWarningMinutes };
}

export function loadSupervisionConfig(
	configDir: string,
	examplePath: string,
): SupervisionConfig {
	const configPath = join(configDir, "config.json");
	const { sourcePath, rawConfig } = readConfigWithExampleFallback(
		configPath,
		examplePath,
		"subagent supervision",
	);
	return parseSupervisionConfig(parseConfigJson(rawConfig, sourcePath), sourcePath);
}
