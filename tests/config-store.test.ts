import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = await mkdtemp(join(tmpdir(), "pi-tool-guard-config-"));
const agentDir = join(root, "agent");
const repository = join(root, "project");
const cwd = join(repository, "packages", "api");
process.env.PI_CODING_AGENT_DIR = agentDir;

const {
	addPersistentRule,
	invalidateConfigCache,
	loadConfigs,
} = await import("../extensions/tool-guard/config-store.ts");

test.after(() => rm(root, { recursive: true, force: true }));

test("loads trusted scopes in directory, repo, global order and gates untrusted scopes", async () => {
	await mkdir(join(agentDir, "extensions"), { recursive: true });
	await mkdir(join(repository, ".git"), { recursive: true });
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(
		join(agentDir, "extensions", "tool-guard.json"),
		JSON.stringify({ version: 1, bash: { allow: ["^global$"] } }),
	);
	await writeFile(
		join(repository, ".git", "pi-tool-guard.json"),
		JSON.stringify({ version: 1, bash: { allow: ["^repo$"] } }),
	);
	await writeFile(
		join(cwd, ".pi", "tool-guard.json"),
		JSON.stringify({ version: 1, bash: { allow: ["^directory$"] } }),
	);

	const trustedContext = { cwd, isProjectTrusted: () => true };
	const trusted = await loadConfigs(trustedContext);
	assert.deepEqual(
		trusted.allowRules.map((rule) => rule.source),
		["^directory$", "^repo$", "^global$"],
	);
	assert.equal(
		trusted.repoLocation?.configPath,
		join(repository, ".git", "pi-tool-guard.json"),
	);

	invalidateConfigCache();
	const untrusted = await loadConfigs({ cwd, isProjectTrusted: () => false });
	assert.deepEqual(
		untrusted.allowRules.map((rule) => rule.source),
		["^global$"],
	);
	assert.equal(untrusted.repo, undefined);
	assert.equal(untrusted.repoLocation, undefined);
});

test("untrusted loads ignore malformed Git metadata", async () => {
	const untrustedRoot = await mkdtemp(join(tmpdir(), "pi-tool-guard-untrusted-"));
	try {
		const untrustedCwd = join(untrustedRoot, "project");
		await mkdir(untrustedCwd, { recursive: true });
		await writeFile(join(untrustedCwd, ".git"), "malformed git metadata", "utf8");
		invalidateConfigCache();

		const loaded = await loadConfigs({
			cwd: untrustedCwd,
			isProjectTrusted: () => false,
		});
		assert.equal(loaded.repo, undefined);
		assert.equal(loaded.repoLocation, undefined);
		assert.deepEqual(loaded.errors, []);
	} finally {
		await rm(untrustedRoot, { recursive: true, force: true });
	}
});

test("persists directory rules through the shared atomic writer", async () => {
	const context = { cwd, isProjectTrusted: () => true };
	await addPersistentRule(context, "directory", "allow", "^npm\\s+test$");

	const saved = JSON.parse(
		await readFile(join(cwd, ".pi", "tool-guard.json"), "utf8"),
	);
	assert.deepEqual(saved.bash.allow, ["^directory$", { source: "^npm\\s+test$" }]);

	const reloaded = await loadConfigs(context);
	assert.deepEqual(
		reloaded.allowRules.map((rule) => rule.source),
		["^directory$", "^npm\\s+test$", "^repo$", "^global$"],
	);
});
