import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SESSION_RULES_ENTRY_TYPE, LEGACY_SESSION_RULES_ENTRY_TYPE } from "../extensions/tool-guard/constants.ts";
import type { BashRule } from "../extensions/tool-guard/types.ts";

const root = await realpath(await mkdtemp(join(tmpdir(), "guard-git-rules-")));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const { canonicalizeGitTarget, compileStoredGitTargets, addPersistentGitTarget, invalidateConfigCache, loadConfigs } =
	await import("../extensions/tool-guard/config-store.ts");
const { loadSessionRules, persistedSessionRules } = await import("../extensions/tool-guard/session-rules.ts");
test.after(async () => {
	if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
	await rm(root, { recursive: true, force: true });
});

function load(data: unknown) {
	return loadSessionRules({ sessionManager: { getEntries: () => [
		{ type: "custom", customType: SESSION_RULES_ENTRY_TYPE, data },
	] } });
}
const target = { gitDir: join(root, "repo", ".git"), workTree: join(root, "repo") };
const bare = { gitDir: join(root, "bare.git") };

test("session Git targets round-trip independently of shell and write rules", () => {
	const allow: BashRule = { source: "^git push$", regex: /^git push$/, scope: "session", list: "allow" };
	const deny: BashRule = { source: "^git reset", regex: /^git reset/, scope: "session", list: "deny" };
	const stored = persistedSessionRules([allow], [deny], [root], [target, bare]);
	assert.deepEqual(stored.git?.allowTargets, [target, bare]);
	const loaded = load(JSON.parse(JSON.stringify(stored)));
	assert.deepEqual(loaded.gitAllowTargets, [target, bare]);
	assert.deepEqual(loaded.allowRules.map((rule) => rule.source), [allow.source]);
	assert.deepEqual(loaded.denyRules.map((rule) => rule.source), [deny.source]);
	assert.deepEqual(loaded.writeAllowDirectories, [root]);
	assert.deepEqual(loaded.errors, []);
	assert.deepEqual(persistedSessionRules([], [], []).git?.allowTargets, []);
});

test("session rules use the latest recognized entry and support old entries without Git targets", () => {
	const loaded = loadSessionRules({ sessionManager: { getEntries: () => [
		{ type: "custom", customType: SESSION_RULES_ENTRY_TYPE, data: { git: { allowTargets: [target] } } },
		{ type: "custom", customType: LEGACY_SESSION_RULES_ENTRY_TYPE, data: { bashAllowRules: ["^old$"] } },
		{ type: "custom", customType: "unrelated", data: { git: { allowTargets: [bare] } } },
	] } });
	assert.deepEqual(loaded.gitAllowTargets, []);
	assert.equal(loaded.allowRules[0].source, "^old$");
	assert.deepEqual(loaded.errors, []);
	assert.deepEqual(loadSessionRules({ sessionManager: { getEntries: () => [] } }).gitAllowTargets, []);
});

test("invalid persisted Git targets are rejected while valid entries remain", () => {
	const invalid = [null, [], {}, { gitDir: "relative" }, { gitDir: 1 },
		{ gitDir: root, workTree: "relative" }, { gitDir: `${root}\0bad` }, { gitDir: root, workTree: null }];
	const loaded = load({ git: { allowTargets: [target, ...invalid, bare] } });
	assert.deepEqual(loaded.gitAllowTargets, [target, bare]);
	assert.equal(loaded.errors.length, invalid.length);
	for (const entry of invalid) {
		assert.throws(() => canonicalizeGitTarget(entry));
		assert.throws(() => persistedSessionRules([], [], [], [entry as any]));
	}
	assert.match(load({ git: { allowTargets: "invalid" } }).errors[0], /must be an array/);
	assert.deepEqual(compileStoredGitTargets(undefined, "test"), { targets: [], errors: [] });
});

test("Git target canonicalization resolves symlinks through missing descendants", { skip: process.platform === "win32" }, async () => {
	const physical = join(root, "physical");
	const alias = join(root, "alias");
	await mkdir(physical);
	await symlink(physical, alias);
	const canonical = { gitDir: join(physical, "missing", ".git"), workTree: physical };
	const input = { gitDir: join(alias, "missing", ".git"), workTree: alias };
	assert.deepEqual(canonicalizeGitTarget(input), canonical);
	assert.deepEqual(load({ git: { allowTargets: [input] } }).gitAllowTargets, [canonical]);
	assert.deepEqual(persistedSessionRules([], [], [], [input]).git?.allowTargets, [canonical]);
	const ctx = { cwd: physical, isProjectTrusted: () => true };
	await addPersistentGitTarget(ctx, "directory", input);
	const stored = JSON.parse(await readFile(join(physical, ".pi", "tool-guard.json"), "utf8"));
	assert.deepEqual(stored.git.allowTargets, [canonical]);
});

test("directory Git targets persist, deduplicate exact pairs, and preserve other rules", async () => {
	const cwd = join(root, "directory");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	const path = join(cwd, ".pi", "tool-guard.json");
	await writeFile(path, JSON.stringify({ version: 1, bash: { allow: ["^npm test$"], deny: ["^rm"] },
		write: { allowDirectories: [root] } }));
	const ctx = { cwd, isProjectTrusted: () => true };
	invalidateConfigCache();
	await addPersistentGitTarget(ctx, "directory", target);
	await addPersistentGitTarget(ctx, "directory", target);
	await addPersistentGitTarget(ctx, "directory", { gitDir: target.gitDir });
	const stored = JSON.parse(await readFile(path, "utf8"));
	assert.deepEqual(stored.git.allowTargets, [target, { gitDir: target.gitDir }]);
	assert.deepEqual(stored.bash, { allow: ["^npm test$"], deny: ["^rm"] });
	assert.deepEqual(stored.write.allowDirectories, [root]);
	invalidateConfigCache();
	const loaded = await loadConfigs(ctx);
	assert.deepEqual(loaded.directory.gitAllowTargets, stored.git.allowTargets);
	assert.deepEqual(loaded.gitAllowTargets, stored.git.allowTargets);
	const untrusted = await loadConfigs({ cwd, isProjectTrusted: () => false });
	assert.deepEqual(untrusted.gitAllowTargets, []);
});
