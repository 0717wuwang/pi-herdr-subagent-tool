import assert from "node:assert/strict";
import { join, sep } from "node:path";
import { describe, it } from "node:test";
import { normalizeFsPath, samePath } from "../../maestro/core/fs-path.ts";

const absolute = process.platform === "win32" ? "C:\\workspace" : "/workspace";

describe("normalizeFsPath", () => {
	it("keeps a native absolute path unchanged", () => {
		assert.equal(normalizeFsPath(absolute), absolute);
	});

	it("resolves a relative path against the working directory", () => {
		assert.equal(normalizeFsPath("child"), join(process.cwd(), "child"));
	});

	it("folds a trailing separator so a reported root is one form", () => {
		assert.equal(normalizeFsPath(`${absolute}${sep}`), absolute);
	});

	it("folds the other separator style Herdr and Git report", () => {
		const mixed =
			process.platform === "win32" ? "C:/workspace/child" : "/workspace/child";
		assert.equal(normalizeFsPath(mixed), join(absolute, "child"));
	});
});

describe("samePath", () => {
	it("matches the same location written with either separator style", () => {
		const other =
			process.platform === "win32" ? "C:/workspace/child" : "/workspace/child";
		assert.equal(samePath(other, join(absolute, "child")), true);
	});

	it("ignores a trailing separator", () => {
		assert.equal(samePath(`${absolute}${sep}`, absolute), true);
	});

	it("distinguishes a parent from its child", () => {
		assert.equal(samePath(absolute, join(absolute, "child")), false);
	});

	it("matches Windows paths that differ only in case", () => {
		const expected = process.platform === "win32";
		assert.equal(samePath(absolute, absolute.toUpperCase()), expected);
	});
});
