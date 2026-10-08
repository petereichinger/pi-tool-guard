import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";

import { normalizeShellPathForHost, physicalShellPath, shellDirectory } from "../extensions/tool-guard/shell-path.ts";

test("maps MSYS drive paths only on Windows", () => {
	for (const [source, expected] of [
		["/c", "C:/"],
		["/c/", "C:/"],
		["/d/some path/repo", "D:/some path/repo"],
		["/Z/repo/link/..", "Z:/repo/link/.."],
	]) {
		assert.equal(normalizeShellPathForHost(source, "win32"), expected);
		assert.equal(normalizeShellPathForHost(source, "linux"), source);
		assert.equal(normalizeShellPathForHost(source, "darwin"), source);
	}
});

test("leaves native, relative, UNC, and non-drive POSIX paths unchanged", () => {
	for (const path of ["C:/repo", "C:\\repo", "repo/path", "../repo", "/home/repo", "/cc/repo", "//server/share", "\\\\server\\share", ""]) {
		assert.equal(normalizeShellPathForHost(path, "win32"), path, path);
	}
});

test("defaults path normalization to the current host platform", () => {
	assert.equal(normalizeShellPathForHost("/c/repo"), process.platform === "win32" ? "C:/repo" : "/c/repo");
});

test("builds relative physical paths without collapsing parent segments", () => {
	const base = join(tmpdir(), "tool-guard-shell-path");
	assert.equal(physicalShellPath(base, "link/../repo"), `${base}${sep}link/../repo`);
	assert.equal(physicalShellPath(base, ".."), `${base}${sep}..`);
	assert.equal(physicalShellPath(base, ""), `${base}${sep}`);
	const absolute = `${base}${sep}link${sep}..${sep}repo`;
	assert.equal(physicalShellPath(join(tmpdir(), "elsewhere"), absolute), absolute);
});

test("normalizes MSYS absolute paths before deciding whether to prepend the base", { skip: process.platform !== "win32" }, () => {
	assert.equal(physicalShellPath("D:/base", "/c/repo/link/.."), "C:/repo/link/..");
});

test("rejects ambiguous Windows roots", { skip: process.platform !== "win32" }, () => {
	for (const path of ["C:repo", "/home/repo", "\\repo"]) {
		assert.throws(() => physicalShellPath("D:/base", path), /ambiguous Windows root/);
	}
});

test("resolves existing directories and rejects files or missing paths", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "tool-guard-shell-path-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "directory");
	await mkdir(directory);
	assert.equal(await shellDirectory(directory), await realpath(directory));
	const file = join(root, "file");
	await writeFile(file, "contents");
	await assert.rejects(shellDirectory(file), /Not a directory:/);
	await assert.rejects(shellDirectory(join(root, "missing")), { code: "ENOENT" });
});

test("resolves symlinks before parent traversal instead of using lexical normalization", { skip: process.platform === "win32" }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "tool-guard-shell-path-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const base = join(root, "base");
	const target = join(root, "target");
	await mkdir(base);
	await mkdir(join(target, "child"), { recursive: true });
	await mkdir(join(target, "repo"));
	await symlink(join(target, "child"), join(base, "link"));
	assert.equal(await shellDirectory(join(base, "link")), await realpath(join(target, "child")));
	assert.equal(await shellDirectory(physicalShellPath(base, "link/..")), await realpath(target));
	assert.equal(await shellDirectory(physicalShellPath(base, "link/../repo")), await realpath(join(target, "repo")));
	const absolute = `${base}${sep}link${sep}..`;
	assert.equal(await shellDirectory(physicalShellPath(root, absolute)), await realpath(target));
});
