import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { analyzeBash, normalizeCdTargetForHost } from "../extensions/tool-guard/bash-analysis.ts";

test("normalizes MSYS drive paths only on Windows", () => {
	assert.equal(normalizeCdTargetForHost("/d/source/repo", "win32"), "D:/source/repo");
	assert.equal(normalizeCdTargetForHost("/d", "win32"), "D:/");
	assert.equal(normalizeCdTargetForHost("/home/user/repo", "win32"), "/home/user/repo");
	assert.equal(normalizeCdTargetForHost("/d/source/repo", "linux"), "/d/source/repo");
});

test("allows cd into the current directory or a subdirectory", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "tool-guard-cd-"));
	const child = join(cwd, "nested folder");
	await mkdir(child);
	t.after(() => rm(cwd, { recursive: true, force: true }));

	const targets = [cwd, child];
	if (process.platform === "win32") targets.push(child.replace(/^([a-zA-Z]):[\\/]/, (_match, drive) => `/${drive.toLowerCase()}/`).replaceAll("\\", "/"));
	for (const target of targets) {
		const analysis = await analyzeBash(`cd "${target.replaceAll("\\", "/")}"`, cwd);
		assert.deepEqual(analysis.commands.map(({ name, harmless, reason }) => ({ name, harmless, reason })), [
			{ name: "cd", harmless: true, reason: "cd stays inside current working directory" },
		]);
	}
});

test("does not automatically allow cd outside the current directory or to a dynamic destination", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "tool-guard-cd-"));
	try {
		const outside = await analyzeBash("cd ..", cwd);
		assert.equal(outside.commands[0].harmless, false);
		assert.equal(outside.commands[0].reason, "cd leaves current working directory");

		const dynamic = await analyzeBash('cd "$TARGET"', cwd);
		assert.equal(dynamic.commands[0].harmless, false);
		assert.equal(dynamic.commands[0].reason, "cd destination uses shell expansion");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("allows a read-only command that discards output to /dev/null", async () => {
	for (const redirect of [">/dev/null", "2>/dev/null", "&>/dev/null"]) {
		const analysis = await analyzeBash(`rg -n "issue.?8|#8|TODO|planned" README.md AGENTS.md .forgejo .git ${redirect}`);
		assert.deepEqual(analysis.commands.map(({ name, harmless, reason }) => ({ name, harmless, reason })), [
			{ name: "rg", harmless: true, reason: "known read-only command" },
		]);
	}
});

test("analyzes a quoted ssh remote command command-by-command", async () => {
	const analysis = await analyzeBash("ssh host 'ls && rm -rf /tmp/example'");

	assert.deepEqual(
		analysis.commands.map(({ command, name, harmless, splitter }) => ({ command, name, harmless, splitter })),
		[
			{ command: "ssh host", name: "ssh", harmless: false, splitter: undefined },
			{ command: "ls", name: "ls", harmless: true, splitter: "ssh remote →" },
			{ command: "rm -rf /tmp/example", name: "rm", harmless: false, splitter: "&&" },
		],
	);
});

test("accounts for ssh options and space-joined remote argv", async () => {
	const analysis = await analyzeBash("ssh -p 2222 host echo 'okay; touch /tmp/example'");

	assert.equal(analysis.commands[0].command, "ssh -p 2222 host");
	assert.deepEqual(
		analysis.commands.slice(1).map(({ command, harmless }) => ({ command, harmless })),
		[
			{ command: "echo okay", harmless: true },
			{ command: "touch /tmp/example", harmless: false },
		],
	);
});

test("does not guess an ssh command containing local expansion", async () => {
	const analysis = await analyzeBash('ssh host "$REMOTE_COMMAND"');

	assert.equal(analysis.commands.length, 1);
	assert.equal(analysis.commands[0].name, "ssh");
	assert.equal(analysis.commands[0].harmless, false);
});
