import { isAbsolute, join, resolve } from "node:path";
const CASE_INSENSITIVE = process.platform === "win32";

/** Folds separator style, a trailing separator, and Windows case. */
function fold(value: string): string {
	const trimmed = value.replace(/[\\/]+$/, "");
	return CASE_INSENSITIVE ? trimmed.replace(/\\/g, "/").toLowerCase() : trimmed;
}

/**
 * One canonical form for a path Herdr, Git, or a manifest reported. Windows
 * tools mix `C:\workspace` and `C:/workspace`, and a root path can arrive with
 * a trailing separator, so every boundary resolves to its native absolute form
 * before anything compares or stores it.
 */
export function normalizeFsPath(value: string): string {
	return resolve(value);
}

/** Whether two reported paths name the same location despite form differences. */
export function samePath(left: string, right: string): boolean {
	return (
		fold(left) === fold(right) || fold(resolve(left)) === fold(resolve(right))
	);
}

/**
 * A caller-supplied cwd is absolute or relative to the launch base. A POSIX
 * prefix test treats `C:\repo` as relative and duplicates the base, so ask the
 * platform path rules instead.
 */
export function resolveAgainstCwd(rawCwd: string, cwdBase: string): string {
	return isAbsolute(rawCwd) ? rawCwd : join(cwdBase, rawCwd);
}
