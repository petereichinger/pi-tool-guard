import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SESSION_RULES_ENTRY_TYPE } from "../extensions/tool-guard/constants.ts";
import type { GitTarget } from "../extensions/tool-guard/types.ts";

const root = await realpath(await mkdtemp(join(tmpdir(), "guard-git-deny-")));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const { addPersistentGitTarget, removePersistentGitTargets, invalidateConfigCache, loadConfigs } =
	await import("../extensions/tool-guard/config-store.ts");
const { loadSessionRules, persistedSessionRules } = await import("../extensions/tool-guard/session-rules.ts");
test.after(async () => {
	if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
	await rm(root, { recursive: true, force: true });
});
const target = { gitDir: join(root, "repo", ".git"), workTree: join(root, "repo") };
const bare = { gitDir: join(root, "bare.git") };
function load(data: unknown) {
	return loadSessionRules({ sessionManager: { getEntries: () => [
		{ type: "custom", customType: SESSION_RULES_ENTRY_TYPE, data },
	] } });
}

test("session Git deny targets round-trip independently and default to empty", () => {
	const stored = persistedSessionRules([], [], [root], [target], [target, bare]);
	assert.deepEqual(stored.git?.denyTargets, [target, bare]);
	const loaded = load(JSON.parse(JSON.stringify(stored)));
	assert.deepEqual(loaded.gitAllowTargets, [target]);
	assert.deepEqual(loaded.gitDenyTargets, [target, bare]);
	assert.deepEqual(loaded.errors, []);
	assert.deepEqual(persistedSessionRules([], [], []).git?.denyTargets, []);
	assert.deepEqual(load({}).gitDenyTargets, []);
	assert.deepEqual(loadSessionRules({ sessionManager: { getEntries: () => [] } }).gitDenyTargets, []);
});

test("session Git deny validation rejects malformed entries and preserves valid targets", () => {
	const invalid = [null, [], {}, { gitDir: "relative" }, { gitDir: root, workTree: null }, { gitDir: `${root}\0bad` }];
	const loaded = load({ git: { allowTargets: [target], denyTargets: [target, ...invalid, bare] } });
	assert.deepEqual(loaded.gitAllowTargets, [target]);
	assert.deepEqual(loaded.gitDenyTargets, [target, bare]);
	assert.equal(loaded.errors.length, invalid.length);
	for (const entry of invalid) assert.throws(() => persistedSessionRules([], [], [], [], [entry as any]));
	assert.match(load({ git: { denyTargets: "bad" } }).errors[0], /denyTargets must be an array/);
});

test("persistent Git deny targets deduplicate, load, and clear without changing allows", async () => {
	const cwd = join(root, "directory");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	const path = join(cwd, ".pi", "tool-guard.json");
	await writeFile(path, JSON.stringify({ bash: { allow: ["^ok$"], deny: ["^bad$"] },
		write: { allowDirectories: [root] }, git: { allowTargets: [target] } }));
	const ctx = { cwd, isProjectTrusted: () => true };
	invalidateConfigCache();
	await addPersistentGitTarget(ctx, "directory", target, "deny");
	await addPersistentGitTarget(ctx, "directory", target, "deny");
	await addPersistentGitTarget(ctx, "directory", bare, "deny");
	let stored = JSON.parse(await readFile(path, "utf8"));
	assert.deepEqual(stored.git, { allowTargets: [target], denyTargets: [target, bare] });
	assert.deepEqual(stored.bash, { allow: ["^ok$"], deny: ["^bad$"] });
	assert.deepEqual(stored.write.allowDirectories, [root]);
	invalidateConfigCache();
	const loaded = await loadConfigs(ctx);
	assert.deepEqual(loaded.directory.gitDenyTargets, [target, bare]);
	assert.deepEqual(loaded.gitDenyTargets, [target, bare]);
	assert.deepEqual((await loadConfigs({ cwd, isProjectTrusted: () => false })).gitDenyTargets, []);
	await removePersistentGitTargets(ctx, "directory", "1", "deny");
	assert.deepEqual((await loadConfigs(ctx)).gitDenyTargets, [bare]);
	await assert.rejects(removePersistentGitTargets(ctx, "directory", "2", "deny"), /No directory Git target/);
	await removePersistentGitTargets(ctx, "directory", "all", "deny");
	stored = JSON.parse(await readFile(path, "utf8"));
	assert.deepEqual(stored.git, { allowTargets: [target], denyTargets: [] });
});

test("persistent Git deny validation reports errors and permits clearing malformed lists", async () => {
	const cwd = join(root, "invalid");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(join(cwd, ".pi", "tool-guard.json"), JSON.stringify({ git: { allowTargets: [target], denyTargets: [target, {}] } }));
	const ctx = { cwd, isProjectTrusted: () => true };
	invalidateConfigCache();
	const loaded = await loadConfigs(ctx);
	assert.deepEqual(loaded.gitDenyTargets, [target]);
	assert.equal(loaded.errors.length, 1);
	await assert.rejects(addPersistentGitTarget(ctx, "directory", bare, "deny"), /ignored Git target/);
	await assert.rejects(removePersistentGitTargets(ctx, "directory", "1", "deny"), /Clear all Git targets/);
	await removePersistentGitTargets(ctx, "directory", "all", "deny");
	assert.deepEqual((await loadConfigs(ctx)).gitAllowTargets, [target]);
	assert.deepEqual((await loadConfigs(ctx)).gitDenyTargets, []);
});

test("Git deny command resolves the current repository, lists denies, and clears targets", async () => {
	const { registerGuardCommands } = await import("../extensions/tool-guard/commands.ts");
	const cwd = join(root, "cli-repo");
	await mkdir(join(cwd, ".git", "objects"), { recursive: true });
	await mkdir(join(cwd, ".git", "refs"));
	await writeFile(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
	await writeFile(join(cwd, ".git", "config"), "[core]\n\tbare = false\n");
	const commands = new Map<string, any>();
	const notices: string[] = [];
	const gitAllowTargets: GitTarget[] = [target];
	const gitDenyTargets: GitTarget[] = [];
	let saves = 0;
	registerGuardCommands({ registerCommand: (name: string, options: any) => commands.set(name, options) } as any, {
		bashAllowRules: [], bashDenyRules: [], writeAllowDirectories: [], gitAllowTargets, gitDenyTargets,
		saveSessionRules: () => { saves++; }, getSessionRuleErrors: () => [],
	});
	const ctx = { cwd, isProjectTrusted: () => true, ui: { notify: (message: string) => notices.push(message) } };
	await commands.get("guard-deny-git").handler("", ctx);
	assert.deepEqual(gitDenyTargets, [{ gitDir: join(cwd, ".git"), workTree: cwd }]);
	await commands.get("guard-deny-git").handler("session .", ctx);
	assert.equal(gitDenyTargets.length, 1);
	await commands.get("guard-list").handler("session", ctx);
	assert.match(notices.at(-1)!, /Session Git deny targets/);
	await commands.get("guard-clear").handler("session git-deny 1", ctx);
	assert.deepEqual(gitDenyTargets, []);
	assert.deepEqual(gitAllowTargets, [target]);
	await commands.get("guard-deny-git").handler(root, ctx);
	assert.match(notices.at(-1)!, /No Git repository/);
	await commands.get("guard-deny-git").handler("directory", ctx);
	assert.deepEqual((await loadConfigs(ctx)).directory.gitDenyTargets, [{ gitDir: join(cwd, ".git"), workTree: cwd }]);
	await commands.get("guard-clear").handler("directory all", ctx);
	assert.deepEqual((await loadConfigs(ctx)).directory.gitDenyTargets, []);
	await commands.get("guard-deny-git").handler("", ctx);
	await commands.get("guard-clear").handler("session all", ctx);
	assert.deepEqual(gitDenyTargets, []);
	assert.deepEqual(gitAllowTargets, []);
	assert.ok(saves >= 4);
});

test("Git deny targets canonicalize symlinks", { skip: process.platform === "win32" }, async () => {
	const physical = join(root, "physical");
	const alias = join(root, "alias");
	await mkdir(physical);
	await symlink(physical, alias);
	const input = { gitDir: join(alias, "missing", ".git"), workTree: alias };
	const expected = { gitDir: join(physical, "missing", ".git"), workTree: physical };
	assert.deepEqual(load({ git: { denyTargets: [input] } }).gitDenyTargets, [expected]);
	assert.deepEqual(persistedSessionRules([], [], [], [], [input]).git?.denyTargets, [expected]);
});
