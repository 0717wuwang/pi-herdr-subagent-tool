import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfigFor } from "./config-source.ts";
import { isBoolean, isRecord } from "./type-guards.ts";

export interface SidebarConfig {
	/** Mark delegated children's panes for the Herdr sidebar plugin. */
	enabled: boolean;
}

function invalid(source: string, message: string): never {
	throw new Error(`Invalid subagent sidebar config in ${source}: ${message}`);
}

export function parseSidebarConfig(
	rawConfig: any,
	source = "config.jsonl",
): SidebarConfig {
	if (!isRecord(rawConfig)) invalid(source, "root must be an object");
	if (!Object.hasOwn(rawConfig, "sidebar")) return { enabled: false };
	const sidebar = rawConfig.sidebar;
	if (!isRecord(sidebar)) invalid(source, "sidebar must be an object");
	const unsupported = Object.keys(sidebar).filter((key) => key !== "enabled");
	if (unsupported.length > 0)
		invalid(
			source,
			`sidebar has unsupported key(s): ${unsupported.join(", ")}`,
		);
	const enabled = Object.hasOwn(sidebar, "enabled") ? sidebar.enabled : false;
	if (!isBoolean(enabled)) invalid(source, "sidebar.enabled must be a boolean");
	return { enabled };
}

export function loadSidebarConfig(
	configDir: string,
	examplePath: string,
): SidebarConfig {
	let sourcePath = join(configDir, "config.jsonl");
	let rawConfig: string;
	try {
		rawConfig = readFileSync(sourcePath, "utf8");
	} catch (error) {
		// SAFETY: readFileSync only throws Node fs errors here, which carry code.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		sourcePath = examplePath;
		try {
			rawConfig = readFileSync(examplePath, "utf8");
		} catch (exampleError) {
			// SAFETY: readFileSync only throws Node fs errors here, which carry code.
			if ((exampleError as NodeJS.ErrnoException).code === "ENOENT")
				return { enabled: false };
			throw exampleError;
		}
	}
	return parseSidebarConfig(parseConfigFor(rawConfig, sourcePath), sourcePath);
}
