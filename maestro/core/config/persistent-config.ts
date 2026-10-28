import { join } from "node:path";
import { parseConfigJson, readConfigWithExampleFallback } from "./config-source.ts";
import { isFiniteNumber, isRecord } from "./type-guards.ts";

export const DEFAULT_MAX_PERSISTENT_AGENTS = 3;

export interface PersistentConfig {
	maxAgents: number;
}

function invalidPersistentConfig(source: string, message: string): never {
	throw new Error(
		`Invalid persistent specialist config in ${source}: ${message}`,
	);
}

export function parsePersistentConfig(
	rawConfig: any,
	source = "config.json",
): PersistentConfig {
	if (!isRecord(rawConfig)) {
		invalidPersistentConfig(source, "root must be an object");
	}
	if (!Object.hasOwn(rawConfig, "persistent")) {
		return { maxAgents: DEFAULT_MAX_PERSISTENT_AGENTS };
	}
	if (!isRecord(rawConfig.persistent)) {
		invalidPersistentConfig(source, "persistent must be an object");
	}
	const unsupported = Object.keys(rawConfig.persistent).filter(
		(key) => key !== "maxAgents",
	);
	if (unsupported.length > 0) {
		invalidPersistentConfig(
			source,
			`persistent has unsupported key(s): ${unsupported.join(", ")}`,
		);
	}
	if (!Object.hasOwn(rawConfig.persistent, "maxAgents")) {
		return { maxAgents: DEFAULT_MAX_PERSISTENT_AGENTS };
	}
	const { maxAgents } = rawConfig.persistent;
	if (
		!isFiniteNumber(maxAgents) ||
		!Number.isInteger(maxAgents) ||
		maxAgents < 1
	) {
		invalidPersistentConfig(
			source,
			"persistent.maxAgents must be a positive integer",
		);
	}
	return { maxAgents };
}


export function loadPersistentConfig(
	configDir: string,
	examplePath: string,
): PersistentConfig {
	const configPath = join(configDir, "config.json");
	const { sourcePath, rawConfig } = readConfigWithExampleFallback(
		configPath,
		examplePath,
		"persistent specialist",
	);
	return parsePersistentConfig(parseConfigJson(rawConfig, sourcePath), sourcePath);
}
