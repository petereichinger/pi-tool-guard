import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { confirmShell } from "../extensions/tool-guard/bash-confirm.ts";
import { exactRuleSource } from "../extensions/tool-guard/rule-utils.ts";
import type { BashRule, GitTarget, LoadedConfigState } from "../extensions/tool-guard/types.ts";

function rule(command: string, list: "allow" | "deny" = "allow"): BashRule {
	const source = exactRuleSource(command);
	return { source, regex: new RegExp(source), scope: "session", list };
}

async function fixture(t: any) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "guard-git-confirm-")));
	const previous = { ...process.env };
	for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
	process.env.HOME = root;
	process.env.XDG_CONFIG_HOME = join(root, "config");
	t.after(async () => {
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
		await rm(root, { recursive: true, force: true });
	});
	async function repository(name: string): Promise<GitTarget> {
		const workTree = join(root, name);
		const gitDir = join(workTree, ".git");
		await mkdir(join(gitDir, "objects"), { recursive: true });
		await mkdir(join(gitDir, "refs"));
		await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
		await writeFile(join(gitDir, "config"), "[core]\n\tbare = false\n");
		return { gitDir, workTree };
	}
	const target = await repository("repo");
	const prompts: { title: string; choices: string[] }[] = [];
	const answers: string[] = [];
	const sessionTargets: GitTarget[] = [];
	const sessionDenyTargets: GitTarget[] = [];
	const saved: GitTarget[] = [];
	const allow: BashRule[] = [];
	const deny: BashRule[] = [];
	const config = { allowRules: [], denyRules: [], gitAllowTargets: [] } as unknown as LoadedConfigState;
	const ctx = {
		cwd: root, hasUI: true,
		ui: {
			select: async (title: string, choices: string[]) => {
				prompts.push({ title, choices });
				const answer = answers.shift();
				assert.ok(answer, `Unexpected prompt: ${title}`);
				assert.ok(choices.includes(answer), `${answer} not in ${choices}`);
				return answer;
			},
			notify: () => {},
		},
	};
	const run = (command: string) => confirmShell(ctx, "bash", command, allow, deny, config,
		undefined, undefined, undefined, undefined, {
			sessionTargets,
			sessionDenyTargets,
			saveTarget: async (scope, value) => {
				assert.equal(scope, "session");
				saved.push(value);
				sessionTargets.push(value);
			},
		});
	return { root, target, repository, ctx, config, prompts, answers, sessionTargets, sessionDenyTargets, saved, allow, deny, run };
}

function stages(prompts: { title: string }[]) {
	return prompts.map(({ title }) => title.startsWith("Allow Git target?") ? "target"
		: title.startsWith("Allow bash command?") ? "operation" : "save");
}

test("the current repository is allowed by default without storing an approval", async (t) => {
	const f = await fixture(t);
	f.ctx.cwd = f.target.workTree!;
	f.ctx.hasUI = false;
	assert.equal(await f.run("git status"), undefined);
	assert.equal(await f.run(`git -C '${f.target.workTree}' status`), undefined);
	assert.deepEqual(f.sessionTargets, []);
	assert.deepEqual(f.prompts, []);
});

test("static cd preserves current repository approval and target denies", async (t) => {
	const f = await fixture(t);
	f.ctx.cwd = f.target.workTree!;
	f.ctx.hasUI = false;
	await mkdir(join(f.ctx.cwd, "nested"));
	for (const command of ["cd . && git status", "cd nested && git status && git diff", `cd '${f.ctx.cwd.replaceAll("\\", "/")}' && git status`]) {
		assert.equal(await f.run(command), undefined, command);
	}
	f.sessionDenyTargets.push(f.target);
	assert.match((await f.run("cd . && git status"))?.reason ?? "", /Git target denied/);
	assert.deepEqual(f.prompts, []);
	assert.deepEqual(f.sessionTargets, []);
});

test("cd to another repository still requires target approval", async (t) => {
	const f = await fixture(t);
	const other = await f.repository("other");
	f.ctx.cwd = f.target.workTree!;
	f.answers.push("Deny");
	assert.equal((await f.run(`cd '${other.workTree!.replaceAll("\\", "/")}' && git status`))?.block, true);
	assert.deepEqual(stages(f.prompts), ["target"]);
	assert.ok(f.prompts[0].title.includes(other.gitDir));
	assert.ok(!f.prompts[0].title.includes("Unknown target"));
});

test("external command approval does not need current Git target approval", async (t) => {
	const f = await fixture(t);
	f.ctx.cwd = f.target.workTree!;
	const command = "gh stack view; git status --short; git diff --stat; git diff --check";
	f.answers.push("Allow once");
	assert.equal(await f.run(command), undefined);
	assert.deepEqual(stages(f.prompts), ["operation"]);
	assert.ok(f.prompts[0].title.includes("gh stack view"));
	assert.deepEqual(f.sessionTargets, []);
	f.allow.push(rule("gh stack view"));
	f.ctx.hasUI = false;
	assert.equal(await f.run(command), undefined);
	f.sessionDenyTargets.push(f.target);
	assert.match((await f.run(command))?.reason ?? "", /Git target denied/);
});

test("external commands preserve other Git targets and Git operation checks", async (t) => {
	const f = await fixture(t);
	const other = await f.repository("other");
	f.ctx.cwd = f.target.workTree!;
	f.allow.push(rule("gh stack view"));
	f.answers.push("Deny", "Deny");
	assert.equal((await f.run(`gh stack view; git -C '${other.workTree!.replaceAll("\\", "/")}' status`))?.block, true);
	assert.equal((await f.run("gh stack view; git push"))?.block, true);
	assert.deepEqual(stages(f.prompts), ["target", "operation"]);
	assert.ok(!f.prompts[0].title.includes("Unknown target"));
	f.deny.push(rule("git status", "deny"));
	assert.match((await f.run("gh stack view; git status"))?.reason ?? "", /denied by/);
});

test("safe global includes preserve current repository approval and explicit denies", async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.root, ".config", "delta"), { recursive: true });
	await writeFile(join(f.root, ".config", "delta", "delta.gitconfig"), "[delta]\n\tside-by-side = true\n");
	await writeFile(join(f.root, ".gitconfig"), "[include]\n\tpath = ~/.config/delta/delta.gitconfig\n");
	f.ctx.cwd = f.target.workTree!;
	f.ctx.hasUI = false;
	assert.equal(await f.run("git status --short --branch"), undefined);
	f.sessionDenyTargets.push(f.target);
	assert.match((await f.run("git status --short --branch"))?.reason ?? "", /Git target denied/);
	assert.deepEqual(f.prompts, []);
	assert.deepEqual(f.sessionTargets, []);
});

test("current repository approval does not approve Git operations or other repositories", async (t) => {
	const f = await fixture(t);
	const other = await f.repository("other");
	f.ctx.cwd = f.target.workTree!;
	f.answers.push("Deny", "Deny");
	assert.equal((await f.run("git push"))?.block, true);
	assert.equal((await f.run(`git -C '${other.workTree}' status`))?.block, true);
	assert.deepEqual(stages(f.prompts), ["operation", "target"]);
});

test("Git target denies override current repository defaults, target allows, and command allows", async (t) => {
	for (const scope of ["session", "persistent"]) {
		const f = await fixture(t);
		f.ctx.cwd = f.target.workTree!;
		f.sessionTargets.push(f.target);
		f.allow.push(rule("git push"));
		if (scope === "session") f.sessionDenyTargets.push(f.target);
		else f.config.gitDenyTargets = [f.target];
		assert.match((await f.run("git push"))?.reason ?? "", /Git target denied/);
		assert.match((await f.run("git status"))?.reason ?? "", /Git target denied/);
		assert.deepEqual(f.prompts, []);
	}
});

test("Git target approval precedes operation approval and once approvals do not persist", async (t) => {
	const f = await fixture(t);
	f.answers.push("Allow once", "Allow once", "Allow once", "Allow once");
	assert.equal(await f.run("git -C repo push"), undefined);
	assert.equal(await f.run("git -C repo push"), undefined);
	assert.deepEqual(stages(f.prompts), ["target", "operation", "target", "operation"]);
	assert.deepEqual(f.saved, []);
	assert.deepEqual(f.allow, []);
});

test("harmless Git operations still require target approval", async (t) => {
	const f = await fixture(t);
	f.answers.push("Allow once");
	assert.equal(await f.run("git -C repo status"), undefined);
	assert.deepEqual(stages(f.prompts), ["target"]);
	assert.ok(f.prompts[0].title.includes(f.target.gitDir));
	assert.ok(f.prompts[0].title.includes(f.target.workTree!));
});

test("normalized push allow rules cannot bypass target approval", async (t) => {
	const f = await fixture(t);
	f.allow.push(rule("git push"));
	f.answers.push("Deny", "Allow once");
	assert.equal((await f.run("git -C repo push"))?.block, true);
	assert.equal(await f.run("git -C repo push"), undefined);
	assert.deepEqual(stages(f.prompts), ["target", "target"]);
});

test("raw and normalized denies override saved targets and command allows", async (t) => {
	const f = await fixture(t);
	f.sessionTargets.push(f.target);
	f.allow.push(rule("git push"));
	for (const command of ["git -C repo push", "git push"]) {
		f.deny.splice(0, f.deny.length, rule(command, "deny"));
		const result = await f.run("git -C repo push");
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /denied by/);
	}
	assert.deepEqual(f.prompts, []);
});

test("Git target matching requires exact metadata and worktree", async (t) => {
	const f = await fixture(t);
	for (const target of [{ gitDir: f.target.gitDir }, { ...f.target, workTree: f.root },
		{ ...f.target, gitDir: join(f.root, "other.git") }]) {
		f.sessionTargets.splice(0, f.sessionTargets.length, target);
		f.answers.push("Deny");
		assert.equal((await f.run("git -C repo status"))?.block, true);
	}
	f.sessionTargets.splice(0, f.sessionTargets.length, f.target);
	assert.equal(await f.run("git -C repo status"), undefined);
	assert.deepEqual(stages(f.prompts), ["target", "target", "target"]);
});

test("session target save is reusable but does not save an operation rule", async (t) => {
	const f = await fixture(t);
	f.answers.push("Save Git target allow…", "session", "Allow once", "Allow once");
	assert.equal(await f.run("git -C repo push"), undefined);
	assert.equal(await f.run("git -C repo push"), undefined);
	assert.deepEqual(f.saved, [f.target]);
	assert.deepEqual(f.allow, []);
	assert.deepEqual(stages(f.prompts), ["target", "save", "operation", "operation"]);
	f.allow.push(rule("git push"));
	assert.equal(await f.run("git -C repo push"), undefined);
	assert.equal(f.prompts.length, 4);
});

test("once approves a resolved target for all subcommands in only the current tool call", async (t) => {
	const f = await fixture(t);
	const command = "git -C repo status && git -C ./repo diff && git -C repo push";
	for (let call = 0; call < 2; call += 1) {
		f.answers.push("Allow once", "Allow once");
		assert.equal(await f.run(command), undefined);
	}
	assert.deepEqual(stages(f.prompts), ["target", "operation", "target", "operation"]);
	assert.deepEqual(f.sessionTargets, []);
	assert.deepEqual(f.saved, []);
});

test("once does not approve a different worktree paired with the same metadata", async (t) => {
	const f = await fixture(t);
	f.answers.push("Allow once", "Deny");
	const command = `git -C repo status && git --git-dir='${f.target.gitDir}' --work-tree='${f.root}' status`;
	assert.equal((await f.run(command))?.block, true);
	assert.deepEqual(stages(f.prompts), ["target", "target"]);
	assert.ok(f.prompts[1].title.includes(`Worktree: ${f.root}`));
});

test("unknown targets still require separate approval for each subcommand", async (t) => {
	const f = await fixture(t);
	f.answers.push("Allow once", "Deny");
	assert.equal((await f.run('git -C "$REPO" status && git -C "$REPO" diff'))?.block, true);
	assert.deepEqual(stages(f.prompts), ["target", "target"]);
	assert.ok(f.prompts.every((prompt) => prompt.title.includes("Unknown target")));
});

test("all Git targets are approved before once allows a multi-command operation", async (t) => {
	const f = await fixture(t);
	await f.repository("second");
	f.answers.push("Allow once", "Allow once", "Allow once");
	assert.equal(await f.run("git -C repo push && git -C second push"), undefined);
	assert.deepEqual(stages(f.prompts), ["target", "target", "operation"]);
	assert.match(f.prompts[0].title, /repo push/);
	assert.match(f.prompts[1].title, /second push/);
	assert.ok(f.prompts.every((prompt) => !prompt.title.includes("Unknown target")));
});

test("a blocked later Git target prevents operation-once approval", async (t) => {
	const f = await fixture(t);
	await f.repository("second");
	f.answers.push("Allow once", "Deny");
	assert.equal((await f.run("git -C repo push && git -C second push"))?.block, true);
	assert.deepEqual(stages(f.prompts), ["target", "target"]);
});

test("saving a normalized command rule does not approve its Git target", async (t) => {
	const f = await fixture(t);
	f.answers.push("Allow once", "Save allow rule…", "session", "Exact command");
	assert.equal(await f.run("git -C repo push"), undefined);
	assert.equal(f.allow.length, 1);
	assert.equal(f.allow[0].regex.test("git push"), true);
	assert.deepEqual(f.sessionTargets, []);
	f.answers.push("Allow once");
	assert.equal(await f.run("git -C repo push"), undefined);
	assert.deepEqual(stages(f.prompts), ["target", "operation", "save", "save", "target"]);
});

test("non-UI Git requests fail closed at target and operation gates", async (t) => {
	const f = await fixture(t);
	f.ctx.hasUI = false;
	f.allow.push(rule("git push"));
	assert.match((await f.run("git -C repo push"))?.reason ?? "", /Git target blocked/);
	f.sessionTargets.push(f.target);
	f.allow.length = 0;
	assert.match((await f.run("git -C repo push"))?.reason ?? "", /no UI.*potentially harmful/);
	assert.equal(await f.run("git -C repo status"), undefined);
	assert.deepEqual(f.prompts, []);
});

test("dynamic Git targets can be approved once but offer no save action", async (t) => {
	const f = await fixture(t);
	f.answers.push("Allow once", "Allow once");
	assert.equal(await f.run('git -C "$REPO" push'), undefined);
	assert.deepEqual(stages(f.prompts), ["target", "operation"]);
	assert.match(f.prompts[0].title, /Unknown target/);
	assert.deepEqual(f.prompts[0].choices, ["Allow once", "Deny"]);
	assert.deepEqual(f.saved, []);
});

test("queued Git requests resolve their targets again before approval", async (t) => {
	const f = await fixture(t);
	const other = await f.repository("other");
	f.sessionTargets.push(f.target);
	f.allow.push(rule("git push"));
	f.ctx.hasUI = false;
	const result = await confirmShell(f.ctx, "bash", "git -C repo push", f.allow, f.deny, f.config,
		undefined, async (request) => {
			await rm(f.target.gitDir, { recursive: true });
			await writeFile(f.target.gitDir, `gitdir: ${other.gitDir}\n`);
			return request();
		}, undefined, undefined, { sessionTargets: f.sessionTargets, saveTarget: async () => {} });
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /Git target blocked/);
});

test("Git output redirects remain dangerous after target approval", async (t) => {
	const f = await fixture(t);
	f.sessionTargets.push(f.target);
	f.answers.push("Deny");
	assert.equal((await f.run("git -C repo status > output"))?.block, true);
	assert.deepEqual(stages(f.prompts), ["operation"]);
	assert.match(f.prompts[0].title, /> output/);
});
