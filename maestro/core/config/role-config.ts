import { join } from "node:path";
import {
	parseConfigFor,
	readConfigWithExampleFallback,
} from "./config-source.ts";
import { isBoolean, isPlainObject } from "./type-guards.ts";

export interface RoleConfig {
	/** Accepted no-op settings, each with actionable migration text. */
	deprecations: string[];
}

function invalidRoleConfig(source: string, message: string): never {
	throw new Error(`Invalid subagent role config in ${source}: ${message}`);
}

export function parseRoleConfig(
	rawConfig: any,
	source = "config.jsonl",
): RoleConfig {
	if (!isPlainObject(rawConfig)) {
		invalidRoleConfig(source, "root must be an object");
	}
	if (!Object.hasOwn(rawConfig, "roles")) return { deprecations: [] };
	if (!isPlainObject(rawConfig.roles)) {
		invalidRoleConfig(source, "roles must be an object");
	}

	const unsupportedKeys = Object.keys(rawConfig.roles).filter(
		(key) => key !== "bundled",
	);
	if (unsupportedKeys.length > 0) {
		invalidRoleConfig(
			source,
			`roles has unsupported key(s): ${unsupportedKeys.join(", ")}`,
		);
	}
	if (!Object.hasOwn(rawConfig.roles, "bundled")) return { deprecations: [] };
	if (!isBoolean(rawConfig.roles.bundled)) {
		invalidRoleConfig(source, "roles.bundled must be a boolean");
	}
	// The host ships no roles, so both legacy booleans are no-ops. Never rewrite
	// user configuration to remove the key.
	return {
		deprecations: [
			`Deprecated setting roles.bundled (${rawConfig.roles.bundled}) in ${source} is ignored: pi-herdr-agents no longer ships bundled roles. Install a role pack or add global or project definitions for the roles you use, then remove roles.bundled. The file was not changed.`,
		],
	};
}

export function loadRoleConfig(
	configDir: string,
	examplePath: string,
): RoleConfig {
	const configPath = join(configDir, "config.jsonl");
	const { sourcePath, rawConfig } = readConfigWithExampleFallback(
		configPath,
		examplePath,
		"subagent role",
	);
	return parseRoleConfig(parseConfigFor(rawConfig, sourcePath), sourcePath);
}
