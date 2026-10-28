import { readFileSync } from "node:fs";

/**
 * Source of a parsed subagent config: where it was read from and the raw text.
 */
export interface ConfigSource {
	sourcePath: string;
	rawConfig: string;
}

/**
 * Read a subagent config file, falling back to the packaged example when the
 * local file does not exist. Throws the shared "Missing <label> config" error
 * when neither path exists.
 */
export function readConfigWithExampleFallback(
	configPath: string,
	examplePath: string,
	label: string,
): ConfigSource {
	try {
		return {
			sourcePath: configPath,
			rawConfig: readFileSync(configPath, "utf8"),
		};
	} catch (error) {
		// SAFETY: readFileSync only throws Node fs errors here, which carry code.
		const errno = error as NodeJS.ErrnoException;
		if (errno.code !== "ENOENT") throw error;
	}

	try {
		return {
			sourcePath: examplePath,
			rawConfig: readFileSync(examplePath, "utf8"),
		};
	} catch (error) {
		// SAFETY: see the preceding readFileSync error handling.
		const errno = error as NodeJS.ErrnoException;
		if (errno.code === "ENOENT") {
			throw new Error(
				`Missing ${label} config. Expected ${configPath} or ${examplePath}.`,
			);
		}
		throw error;
	}
}

/**
 * Parse config JSON, wrapping parse failures with the shared source path.
 */
export function parseConfigJson(rawConfig: string, sourcePath: string): any {
	try {
		return JSON.parse(rawConfig);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid JSON in subagent config ${sourcePath}: ${detail}`);
	}
}
