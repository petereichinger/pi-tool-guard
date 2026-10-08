import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { analyzeBash } from "../extensions/tool-guard/bash-analysis.ts";
import { normalizeShellPathForHost } from "../extensions/tool-guard/shell-path.ts";

async function fixture(t: any) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "tool-guard-cd-")));
	const cwd = join(root, "home");
	await mkdir(join(cwd, "nested"), { recursive: true });
	const keys = ["HOME", "TOOL_GUARD_TEST_TARGET", "TARGET"];
	const inherited = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	process.env.HOME = cwd.replaceAll("\\", "/");
	process.env.TOOL_GUARD_TEST_TARGET = join(cwd, "nested").replaceAll("\\", "/");
	delete process.env.TARGET;
	t.after(async () => {
		for (const key of keys) {
			if (inherited[key] === undefined) delete process.env[key];
			else process.env[key] = inherited[key];
		}
		await rm(root, { recursive: true, force: true });
	});
	return { root, cwd };
}

test("normalizes MSYS drive paths only on Windows", () => {
	assert.equal(normalizeShellPathForHost("/d/source/repo", "win32"), "D:/source/repo");
	assert.equal(normalizeShellPathForHost("/d", "win32"), "D:/");
	assert.equal(normalizeShellPathForHost("/home/user/repo", "win32"), "/home/user/repo");
	assert.equal(normalizeShellPathForHost("/d/source/repo", "linux"), "/d/source/repo");
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

test("does not automatically allow cd outside the current directory or to a dynamic destination", async (t) => {
	const { cwd } = await fixture(t);
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

test("allows cd to inherited home and simple environment variable paths", async (t) => {
	const { cwd } = await fixture(t);
	for (const target of ["$HOME", "${HOME}/nested", '"$HOME/nested"', '"${HOME}"', "$TOOL_GUARD_TEST_TARGET", '"${TOOL_GUARD_TEST_TARGET}"']) {
		const analysis = await analyzeBash(`cd ${target}`, cwd);
		assert.equal(analysis.commands[0].harmless, true, target);
		assert.equal(analysis.commands[0].reason, "cd stays inside current working directory", target);
	}
});

test("requires quotes around expanded cd paths containing spaces", async (t) => {
	const { cwd } = await fixture(t);
	const target = join(cwd, "nested folder");
	await mkdir(target);
	process.env.TOOL_GUARD_TEST_TARGET = target.replaceAll("\\", "/");
	assert.equal((await analyzeBash('cd "$TOOL_GUARD_TEST_TARGET"', cwd)).commands[0].harmless, true);
	assert.equal((await analyzeBash("cd $TOOL_GUARD_TEST_TARGET", cwd)).commands[0].harmless, false);
});

test("does not guess cd targets affected by CDPATH or inline environment assignments", async (t) => {
	const { cwd } = await fixture(t);
	assert.equal((await analyzeBash('CDPATH=/elsewhere cd nested', cwd)).commands[0].harmless, false);
	const previous = process.env.CDPATH;
	t.after(() => {
		if (previous === undefined) delete process.env.CDPATH;
		else process.env.CDPATH = previous;
	});
	process.env.CDPATH = "/elsewhere";
	assert.equal((await analyzeBash('cd nested', cwd)).commands[0].harmless, false);
});

test("does not resolve unknown or complex cd expansions", async (t) => {
	const { cwd } = await fixture(t);
	for (const command of ['cd "$TARGET"', "cd ${TARGET}", 'cd "${HOME:-/elsewhere}"', 'cd "$(pwd)"', "cd $((1 + 1))"]) {
		const analysis = await analyzeBash(command, cwd);
		assert.equal(analysis.commands[0].harmless, false, command);
	}
});

test("does not assume inherited cd variables survive shell mutations or loops", async (t) => {
	const { cwd } = await fixture(t);
	for (const command of [
		'HOME=/elsewhere; cd "$HOME"',
		'export HOME=/elsewhere; cd "${HOME}"',
		'printf -v HOME /elsewhere; cd "$HOME"',
		'for HOME in /elsewhere; do cd "$HOME"; done',
		'TOOL_GUARD_TEST_TARGET=/elsewhere; cd "$TOOL_GUARD_TEST_TARGET"',
	]) {
		const analysis = await analyzeBash(command, cwd);
		const cd = analysis.commands.find((item) => item.name === "cd");
		assert.ok(cd, command);
		assert.equal(cd.harmless, false, command);
	}
});

test("rejects cd through a symlink followed by parent traversal outside cwd", { skip: process.platform === "win32" }, async (t) => {
	const { root, cwd } = await fixture(t);
	await mkdir(join(root, "outside", "child"), { recursive: true });
	await symlink(join(root, "outside", "child"), join(cwd, "link"));
	for (const command of ["cd link/..", 'cd "${HOME}/link/.."']) {
		const analysis = await analyzeBash(command, cwd);
		assert.equal(analysis.commands[0].harmless, false, command);
		assert.equal(analysis.commands[0].reason, "cd leaves current working directory", command);
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
