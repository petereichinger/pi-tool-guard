import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { analyzeBash } from "../extensions/tool-guard/bash-analysis.ts";
import { analyzeGitInvocation } from "../extensions/tool-guard/git-analysis.ts";
import { getBashParser } from "../extensions/tool-guard/tree-sitter.ts";

async function analyze(command: string, cwd?: string) {
	const { parser, error } = await getBashParser();
	assert.ok(parser, error);
	const tree = parser.parse(command);
	const commands = tree.rootNode.descendantsOfType("command");
	assert.ok(commands.length > 0);
	return analyzeGitInvocation(commands[0], cwd);
}

async function metadata(path: string, bare = false) {
	await mkdir(join(path, "objects"), { recursive: true });
	await mkdir(join(path, "refs"));
	await writeFile(join(path, "HEAD"), "ref: refs/heads/main\n");
	await writeFile(join(path, "config"), `[core]\n\tbare = ${bare}\n`);
}

async function fixture(t: any) {
	const root = await mkdtemp(join(tmpdir(), "tool-guard-git-"));
	const repo = join(root, "repo");
	await mkdir(repo);
	await metadata(join(repo, ".git"));
	t.after(() => rm(root, { recursive: true, force: true }));
	process.env.HOME = root;
	process.env.XDG_CONFIG_HOME = join(root, ".config");
	return { root: await realpath(root), repo: await realpath(repo), gitDir: await realpath(join(repo, ".git")) };
}

const inheritedGitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")));
const inheritedHome = process.env.HOME;
const inheritedXdg = process.env.XDG_CONFIG_HOME;
for (const key of Object.keys(inheritedGitEnv)) delete process.env[key];
test.after(() => {
	Object.assign(process.env, inheritedGitEnv);
	if (inheritedHome === undefined) delete process.env.HOME;
	else process.env.HOME = inheritedHome;
	if (inheritedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = inheritedXdg;
});

test("discovers metadata from a nested working directory", async (t) => {
	const { repo, gitDir } = await fixture(t);
	const nested = join(repo, "nested", "directory");
	await mkdir(nested, { recursive: true });
	assert.deepEqual(await analyze("git status --short", nested), {
		command: "git status --short", target: { gitDir, workTree: repo },
	});
});

test("normalizes repeated and attached -C options relative to each preceding directory", async (t) => {
	const { root, repo, gitDir } = await fixture(t);
	await mkdir(join(repo, "nested"));
	assert.deepEqual(await analyze("git -C repo -Cnested -C '' --no-pager status --short", root), {
		command: "git --no-pager status --short", target: { gitDir, workTree: repo },
	});
});

test("resolves relative metadata and worktree options against the final -C directory", async (t) => {
	const { root, repo, gitDir } = await fixture(t);
	assert.deepEqual(await analyze("git --git-dir=.git --work-tree . -C repo status", root), {
		command: "git status", target: { gitDir, workTree: repo },
	});
});

test("handles split and repeated target options with the last value taking precedence", async (t) => {
	const { root, repo, gitDir } = await fixture(t);
	assert.deepEqual(await analyze("git --git-dir missing --work-tree missing --git-dir repo/.git --work-tree=repo diff", root), {
		command: "git diff", target: { gitDir, workTree: repo },
	});
});

test("removes only target assignments and options, preserving operation arguments and redirects", async (t) => {
	const { root, repo, gitDir } = await fixture(t);
	assert.deepEqual(await analyze("FOO='keep me' GIT_DIR=repo/.git GIT_WORK_TREE=repo git --no-pager diff -- 'some file' >output", root), {
		command: "FOO='keep me' git --no-pager diff -- 'some file' >output", target: { gitDir, workTree: repo },
	});
});

test("inherits Git target environment variables and allows command-line overrides", async (t) => {
	const { root, repo, gitDir } = await fixture(t);
	process.env.GIT_DIR = "missing";
	process.env.GIT_WORK_TREE = "missing";
	t.after(() => {
		delete process.env.GIT_DIR;
		delete process.env.GIT_WORK_TREE;
	});
	assert.deepEqual(await analyze("GIT_DIR=repo/.git GIT_WORK_TREE=repo git status", root), {
		command: "git status", target: { gitDir, workTree: repo },
	});
	process.env.GIT_DIR = "repo/.git";
	process.env.GIT_WORK_TREE = "repo";
	assert.deepEqual(await analyze("git status", root), {
		command: "git status", target: { gitDir, workTree: repo },
	});
	assert.deepEqual(await analyze("git --git-dir=repo/.git --work-tree=repo status", root), {
		command: "git status", target: { gitDir, workTree: repo },
	});
});

test("uses the effective current directory as worktree for an explicit non-bare gitDir", async (t) => {
	const { root, gitDir } = await fixture(t);
	assert.deepEqual(await analyze("git --git-dir=repo/.git status", root), {
		command: "git status", target: { gitDir, workTree: root },
	});
});

test("discovers a linked worktree gitfile without approving its common repository", async (t) => {
	const { root, gitDir } = await fixture(t);
	const linked = join(root, "linked worktree");
	const linkedMetadata = join(gitDir, "worktrees", "linked");
	await mkdir(linked);
	await mkdir(linkedMetadata, { recursive: true });
	await writeFile(join(linkedMetadata, "HEAD"), "ref: refs/heads/linked\n");
	await writeFile(join(linkedMetadata, "commondir"), "../..\n");
	await writeFile(join(linked, ".git"), `gitdir: ${relative(linked, linkedMetadata)}\n`);
	assert.deepEqual(await analyze("git -C 'linked worktree' status", root), {
		command: "git status", target: { gitDir: linkedMetadata, workTree: linked },
	});
});

test("canonicalizes symlinked working directories and metadata", { skip: process.platform === "win32" }, async (t) => {
	const { root, repo, gitDir } = await fixture(t);
	await symlink(repo, join(root, "alias"));
	await symlink(gitDir, join(root, "metadata-alias"));
	assert.deepEqual(await analyze("git status", join(root, "alias")), {
		command: "git status", target: { gitDir, workTree: repo },
	});
	assert.deepEqual(await analyze("git --git-dir=metadata-alias --work-tree=alias diff", root), {
		command: "git diff", target: { gitDir, workTree: repo },
	});
});

test("uses physical directories for repeated -C and parent traversal", { skip: process.platform === "win32" }, async (t) => {
	const { root, repo, gitDir } = await fixture(t);
	await mkdir(join(repo, "nested"));
	await symlink(join(repo, "nested"), join(root, "alias"));
	assert.deepEqual(await analyze("git -Calias -C .. status", root), {
		command: "git status", target: { gitDir, workTree: repo },
	});
});

test("supports explicit bare metadata without a worktree", async (t) => {
	const { root } = await fixture(t);
	const gitDir = join(root, "bare.git");
	await metadata(gitDir, true);
	assert.deepEqual(await analyze("git --git-dir bare.git log", root), {
		command: "git log", target: { gitDir },
	});
	assert.deepEqual(await analyze("git -Cbare.git --bare log", root), {
		command: "git --bare log", target: { gitDir },
	});
});

test("--bare captures the directory at its position before a later -C", async (t) => {
	const { root } = await fixture(t);
	const gitDir = join(root, "bare.git");
	await metadata(gitDir, true);
	await mkdir(join(gitDir, "nested"));
	assert.deepEqual(await analyze("git --bare -Cnested log", gitDir), {
		command: "git --bare log", target: { gitDir },
	});
});

test("keeps arguments after the subcommand, even when they resemble target options", async (t) => {
	const { repo, gitDir } = await fixture(t);
	assert.deepEqual(await analyze("git grep -- -C --git-dir=elsewhere", repo), {
		command: "git grep -- -C --git-dir=elsewhere", target: { gitDir, workTree: repo },
	});
});

test("returns the original command for dynamic, ambiguous, or unsupported invocations", async (t) => {
	const { repo } = await fixture(t);
	for (const command of [
		'git -C "$REPO" status', "git -C ~/repo status", "git -C repo* status", "git -C $(pwd) status",
		"git status *.ts", "GIT_DIR=$REPO git status", "GIT_DIR=~/repo git status", "FOO=$VALUE git status",
		"git -C", "git --git-dir", "git --work-tree", "git --git-dir= status", "git --work-tree= status",
		"git -c core.worktree=/elsewhere status", "git -ccore.bare=true status", "git --config-env=core.worktree=TARGET status",
		"git --namespace=other status", "git --exec-path=/elsewhere status", "git --unknown status",
		"GIT_COMMON_DIR=/elsewhere git status", "GIT_INDEX_FILE=/elsewhere git status", "GIT_OBJECT_DIRECTORY=/elsewhere git status",
		"GIT_CONFIG_COUNT=1 git status", "git --bare --work-tree=. status", "git init /elsewhere", "git clone url /elsewhere",
		"git -C missing status >output", "git custom-command", "git for-each-repo --config=targets status",
	]) {
		const result = await analyze(command, repo);
		assert.equal(result.command, command, command);
		assert.equal(result.target, undefined, command);
		assert.ok(result.error, command);
	}
});

test("rejects inherited target-affecting environment without normalizing", async (t) => {
	const { repo } = await fixture(t);
	process.env.GIT_COMMON_DIR = "";
	t.after(() => delete process.env.GIT_COMMON_DIR);
	const result = await analyze("git -C . status", repo);
	assert.equal(result.command, "git -C . status");
	assert.equal(result.target, undefined);
	assert.match(result.error!, /GIT_COMMON_DIR/);
});

test("rejects an unknown working directory, including remote invocations", async () => {
	for (const cwd of [undefined, "relative/path"]) {
		assert.deepEqual(await analyze("git status", cwd), { command: "git status", error: "Git working directory is unknown" });
	}
});

test("rejects missing or invalid metadata without normalizing", async (t) => {
	const { root, repo } = await fixture(t);
	await mkdir(join(root, "unversioned"));
	await mkdir(join(root, "invalid"));
	await writeFile(join(root, "invalid", ".git"), "not a gitfile\n");
	await mkdir(join(root, "empty"));
	await mkdir(join(root, "empty", ".git"));
	for (const command of ["git -Cunversioned status", "git -Cinvalid status", "git -Cempty status", "git --git-dir=missing status"]) {
		const result = await analyze(command, root);
		assert.equal(result.command, command);
		assert.equal(result.target, undefined);
		assert.ok(result.error);
	}
	assert.ok((await analyze("git --git-dir=. status", repo)).error);
});

test("rejects target-changing config and conditional includes", async (t) => {
	const { repo, gitDir } = await fixture(t);
	for (const config of [
		"[core]\nworktree = /elsewhere\n",
		'[includeIf "gitdir:*"]\npath = /elsewhere\n', "[core]\nbare = maybe\n",
	]) {
		await writeFile(join(gitDir, "config"), config);
		const result = await analyze("git -C . status", repo);
		assert.equal(result.command, "git -C . status");
		assert.equal(result.target, undefined);
		assert.ok(result.error);
	}
	await writeFile(join(gitDir, "config"), "[core]\nbare = false\n");
	for (const config of ["[core]\nworktree = /elsewhere\n", "[core]\nbare = true\n"]) {
		await writeFile(join(gitDir, "config.worktree"), config);
		assert.ok((await analyze("git status", repo)).error);
	}
});

test("rejects target-changing global config selected by the inherited or inline environment", async (t) => {
	const { root, repo } = await fixture(t);
	await writeFile(join(root, ".gitconfig"), "[core]\nworktree = /elsewhere\n");
	const inherited = await analyze("git -C . status", repo);
	assert.equal(inherited.command, "git -C . status");
	assert.equal(inherited.target, undefined);
	assert.match(inherited.error!, /core.worktree/);
	await rm(join(root, ".gitconfig"));
	const otherHome = join(root, "other-home");
	await mkdir(otherHome);
	await writeFile(join(otherHome, ".gitconfig"), "[include]\npath = unsafe.gitconfig\n");
	await writeFile(join(otherHome, "unsafe.gitconfig"), "[core]\nworktree = /elsewhere\n");
	const command = `HOME='${otherHome}' git -C . status`;
	const inline = await analyze(command, repo);
	assert.equal(inline.command, command);
	assert.equal(inline.target, undefined);
	assert.match(inline.error!, /core.worktree/);
});

test("resolves a safe global include using a home-relative path", async (t) => {
	const { root, repo, gitDir } = await fixture(t);
	await writeFile(join(root, ".gitconfig"), "[include]\npath = ~/delta.gitconfig\n");
	await writeFile(join(root, "delta.gitconfig"), "[core]\npager = delta\n[delta]\nside-by-side = true\n");
	assert.deepEqual(await analyze("git -C . status", repo), {
		command: "git status", target: { gitDir, workTree: repo },
	});
});

test("resolves nested relative includes against each containing config in order", async (t) => {
	const { repo, gitDir } = await fixture(t);
	await mkdir(join(gitDir, "includes", "nested"), { recursive: true });
	await writeFile(join(gitDir, "config"), "[include]\npath = includes/first.config\npath = includes/last.config\n");
	await writeFile(join(gitDir, "includes", "first.config"), "[core]\nbare = false\n[include]\npath = nested/bare.config\n");
	await writeFile(join(gitDir, "includes", "nested", "bare.config"), "[core]\nbare = true\n");
	await writeFile(join(gitDir, "includes", "last.config"), "[core]\nbare = false\n");
	assert.deepEqual(await analyze("git status", repo), {
		command: "git status", target: { gitDir, workTree: repo },
	});
	await writeFile(join(gitDir, "includes", "last.config"), "[core]\nbare = true\n");
	assert.deepEqual(await analyze("git status", repo), {
		command: "git status", target: { gitDir },
	});
	await writeFile(join(gitDir, "config"), "[include]\npath = includes/first.config\n[core]\nbare = false\n");
	assert.deepEqual(await analyze("git status", repo), {
		command: "git status", target: { gitDir, workTree: repo },
	});
});

test("resolves quoted absolute include paths with spaces", async (t) => {
	const { root, repo, gitDir } = await fixture(t);
	const included = join(root, "safe config.gitconfig");
	await writeFile(included, "[delta]\nside-by-side = true\n");
	await writeFile(join(gitDir, "config"), `[include]\npath = ${JSON.stringify(included)}\n`);
	assert.deepEqual(await analyze("git status", repo), {
		command: "git status", target: { gitDir, workTree: repo },
	});
});

test("decodes supported Git string escapes in quoted include paths", { skip: process.platform === "win32" }, async (t) => {
	const { repo, gitDir } = await fixture(t);
	for (const [encoded, filename] of [
		["back\\\\slash.config", "back\\slash.config"],
		['double\\"quote.config', 'double"quote.config'],
		["new\\nline.config", "new\nline.config"],
		["tab\\tname.config", "tab\tname.config"],
		["back\\bspace.config", "back\bspace.config"],
	]) {
		await writeFile(join(gitDir, filename), "[core]\nworktree = /elsewhere\n");
		await writeFile(join(gitDir, "config"), `[include]\npath = "${encoded}"\n`);
		const result = await analyze("git -C . status", repo);
		assert.equal(result.command, "git -C . status", encoded);
		assert.equal(result.target, undefined, encoded);
		assert.match(result.error!, /core.worktree/, encoded);
	}
});

test("rejects target-changing and malformed core settings reached through includes", async (t) => {
	const { repo, gitDir } = await fixture(t);
	await writeFile(join(gitDir, "config"), "[include]\npath = included.config\n");
	for (const config of ["[core]\nworktree = /elsewhere\n", "[core]\nbare = maybe\n"]) {
		await writeFile(join(gitDir, "included.config"), config);
		const result = await analyze("git -C . status", repo);
		assert.equal(result.command, "git -C . status");
		assert.equal(result.target, undefined);
		assert.match(result.error!, /core\.(worktree|bare)/);
	}
	await writeFile(join(gitDir, "config"), "[core]\nbare = false\n");
	await writeFile(join(gitDir, "config.worktree"), "[include]\npath = included.config\n");
	await writeFile(join(gitDir, "included.config"), "[core]\nbare = true\n");
	assert.ok((await analyze("git status", repo)).error);
});

test("rejects conditional includes reached through unconditional includes", async (t) => {
	const { repo, gitDir } = await fixture(t);
	await writeFile(join(gitDir, "config"), "[include]\npath = included.config\n");
	await writeFile(join(gitDir, "included.config"), '[includeIf "gitdir:*"]\npath = missing.config\n');
	const result = await analyze("git -C . status", repo);
	assert.equal(result.command, "git -C . status");
	assert.equal(result.target, undefined);
	assert.ok(result.error);
});

test("rejects config include cycles and excessive nesting", async (t) => {
	const { repo, gitDir } = await fixture(t);
	await writeFile(join(gitDir, "config"), "[include]\npath = first.config\n");
	await writeFile(join(gitDir, "first.config"), "[include]\npath = second.config\n");
	await writeFile(join(gitDir, "second.config"), "[include]\npath = first.config\n");
	let result = await analyze("git -C . status", repo);
	assert.equal(result.command, "git -C . status");
	assert.equal(result.target, undefined);
	assert.ok(result.error);
	await writeFile(join(gitDir, "config"), "[include]\npath = depth-1.config\n");
	for (let depth = 1; depth <= 12; depth += 1) {
		await writeFile(join(gitDir, `depth-${depth}.config`), depth === 12
			? "[delta]\nside-by-side = true\n"
			: `[include]\npath = depth-${depth + 1}.config\n`);
	}
	result = await analyze("git -C . status", repo);
	assert.equal(result.command, "git -C . status");
	assert.equal(result.target, undefined);
	assert.ok(result.error);
});

test("ignores absent unconditional include files", async (t) => {
	const { root, repo, gitDir } = await fixture(t);
	await writeFile(join(root, ".gitconfig"), "[include]\npath = ~/missing.config\n");
	await writeFile(join(gitDir, "config"), "[core]\nbare = false\n[include]\npath = missing.config\npath = /elsewhere\n");
	assert.deepEqual(await analyze("git -C . status", repo), {
		command: "git status", target: { gitDir, workTree: repo },
	});
});

test("does not resolve Git aliases that can select another repository", async (t) => {
	const { repo, gitDir } = await fixture(t);
	await writeFile(join(gitDir, "config"), "[core]\nbare = false\n[alias]\nelsewhere = -C /elsewhere status\n");
	const result = await analyze("git -C . elsewhere", repo);
	assert.equal(result.command, "git -C . elsewhere");
	assert.equal(result.target, undefined);
	assert.match(result.error!, /cannot be resolved safely/);
});

test("requires metadata object and reference directories before returning a target", async (t) => {
	const { repo, gitDir } = await fixture(t);
	await rm(join(gitDir, "objects"), { recursive: true });
	const result = await analyze("git -C . status", repo);
	assert.equal(result.command, "git -C . status");
	assert.equal(result.target, undefined);
	assert.ok(result.error);
});

test("resolves symlink traversal before parent segments in a single path", async (t) => {
	const { root, repo } = await fixture(t);
	const other = join(root, "other");
	await mkdir(join(other, "child"), { recursive: true });
	await metadata(join(other, ".git"));
	await symlink(join(other, "child"), join(repo, "link"));
	assert.deepEqual((await analyze("git -C link/.. status", repo)).target, {
		gitDir: join(other, ".git"), workTree: other,
	});
	assert.deepEqual((await analyze("git --git-dir=link/../.git --work-tree=link/.. status", repo)).target, {
		gitDir: join(other, ".git"), workTree: other,
	});
});

test("does not discover an enclosing repository from inside nested bare metadata", async (t) => {
	const { repo } = await fixture(t);
	await metadata(join(repo, "bare"), true);
	const result = await analyze("git -C bare status", repo);
	assert.equal(result.target, undefined);
	assert.match(result.error ?? "", /Bare Git repository/);
});

test("does not assume unchanged Git environment after shell mutations", async (t) => {
	const { repo } = await fixture(t);
	for (const command of [
		"GIT_DIR+=other; git status",
		"printf -v GIT_DIR other; git status",
		"for GIT_DIR in other; do git status; done",
		"export GIT_DIR=other; git status",
	]) {
		const analysis = await analyzeBash(command, repo);
		const git = analysis.commands.find((item) => item.name === "git");
		assert.ok(git);
		assert.equal(git.git?.target, undefined, command);
		assert.ok(git.git?.error, command);
	}
});

test("accepts static shell quoting and escaped spaces without evaluating the shell", async (t) => {
	const { root } = await fixture(t);
	const repo = join(root, "some repo");
	await mkdir(repo);
	const gitDir = join(repo, ".git");
	await metadata(gitDir);
	for (const target of ["'some repo'", '"some repo"', "some\\ repo", "'some '\"repo\""]) {
		assert.deepEqual(await analyze(`git -C ${target} status`, root), {
			command: "git status", target: { gitDir, workTree: repo },
		});
	}
});
