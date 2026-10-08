import { readFile, realpath, stat } from "node:fs/promises";
import { staticShellWord } from "./shell-word.ts";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { physicalShellPath as physicalPath, shellDirectory as directory } from "./shell-path.ts";

export type GitInvocationAnalysis = {
	command: string;
	target?: { gitDir: string; workTree?: string };
	error?: string;
};

const SAFE_GLOBAL_OPTIONS = new Set([
	"-p", "--paginate", "-P", "--no-pager", "--no-replace-objects", "--no-optional-locks",
	"--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-lazy-fetch",
	"--version", "-v", "--help", "-h", "--html-path", "--man-path", "--info-path",
]);

const SUPPORTED_SUBCOMMANDS = new Set([
	"add", "am", "annotate", "apply", "archive", "bisect", "blame", "branch", "bundle", "cat-file",
	"check-attr", "check-ignore", "check-mailmap", "check-ref-format", "checkout", "checkout-index", "cherry",
	"cherry-pick", "clean", "column", "commit", "commit-graph", "commit-tree", "config", "count-objects",
	"credential", "credential-cache", "credential-store", "describe", "diff", "diff-files", "diff-index",
	"diff-tree", "difftool", "fast-export", "fast-import", "fetch", "fetch-pack", "filter-branch", "fmt-merge-msg",
	"for-each-ref", "format-patch", "fsck", "gc", "get-tar-commit-id", "grep", "hash-object", "help", "index-pack",
	"interpret-trailers", "log", "ls-files", "ls-remote", "ls-tree", "mailinfo", "mailsplit", "maintenance",
	"merge", "merge-base", "merge-file", "merge-index", "merge-one-file", "merge-tree", "mktag", "mktree",
	"multi-pack-index", "mv", "name-rev", "notes", "pack-objects", "pack-redundant", "pack-refs", "patch-id",
	"prune", "prune-packed", "pull", "push", "range-diff", "read-tree", "rebase", "reflog", "remote", "repack",
	"replace", "request-pull", "rerere", "reset", "restore", "rev-list", "rev-parse", "revert", "rm", "send-pack",
	"shortlog", "show", "show-branch", "show-index", "show-ref", "sparse-checkout", "stash", "status", "stripspace",
	"submodule", "switch", "symbolic-ref", "tag", "unpack-file", "unpack-objects", "update-index", "update-ref",
	"update-server-info", "upload-archive", "upload-pack", "verify-commit", "verify-pack", "verify-tag",
	"whatchanged", "worktree", "write-tree",
]);


async function optionalFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error: any) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function metadataDirectory(path: string): Promise<string> {
	const canonical = await realpath(physicalPath(process.cwd(), path));
	if ((await stat(canonical)).isDirectory()) return validateMetadataDirectory(canonical);
	const contents = await readFile(canonical, "utf8");
	const match = contents.match(/^gitdir: ([^\r\n]+)\r?\n?$/);
	if (!match) throw new Error(`Invalid Git metadata file: ${path}`);
	return validateMetadataDirectory(physicalPath(dirname(canonical), match[1]));
}

async function validateMetadataDirectory(path: string): Promise<string> {
	const canonical = await directory(path);
	if (!(await stat(join(canonical, "HEAD"))).isFile()) throw new Error(`Git metadata has no HEAD: ${path}`);
	return canonical;
}

async function discover(start: string): Promise<{ gitDir: string; workTree: string }> {
	let current = start;
	while (true) {
		if (await optionalFile(join(current, "HEAD")) !== undefined) {
			try {
				await directory(join(current, "objects"));
				await directory(join(current, "refs"));
				throw new Error("Bare Git repository discovery requires an explicit --git-dir or --bare");
			} catch (error: any) {
				if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
			}
		}
		try {
			await stat(join(current, ".git"));
		} catch (error: any) {
			if (error.code !== "ENOENT") throw error;
			const parent = dirname(current);
			if (parent === current) throw new Error("No Git metadata directory could be discovered");
			current = parent;
			continue;
		}
		return { gitDir: await metadataDirectory(join(current, ".git")), workTree: current };
	}
}

function includePath(value: string, file: string, home?: string): string {
	let path = "";
	let whitespace = "";
	let quoted = false;
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (!quoted && (char === "#" || char === ";")) break;
		if (!quoted && /\s/.test(char)) {
			whitespace += char;
			continue;
		}
		path += whitespace;
		whitespace = "";
		if (char === '"') {
			quoted = !quoted;
		} else if (char === "\\") {
			const escapes: Record<string, string> = { n: "\n", t: "\t", b: "\b", "\\": "\\", '"': '"' };
			const escaped = escapes[value[++index]];
			if (escaped === undefined) throw new Error("Git config include path has an invalid escape");
			path += escaped;
		} else {
			path += char;
		}
	}
	if (quoted) throw new Error("Git config include path has an unterminated quote");
	if (!path || path.includes("\0")) throw new Error("Git config include path is empty or invalid");
	if (path.startsWith("~/")) {
		if (!home) throw new Error("Git config include home directory is unknown");
		return physicalPath(home, path.slice(2));
	}
	if (path.startsWith("~")) throw new Error("Git config include user home cannot be resolved safely");
	return physicalPath(dirname(file), path);
}

async function bareSetting(gitDir: string, cwd: string, env: Record<string, string | undefined>, subcommand?: string): Promise<boolean | undefined> {
	const common = await optionalFile(join(gitDir, "commondir"));
	let configDir = gitDir;
	if (common !== undefined) {
		const path = common.trim();
		if (!path || /[\r\n\0]/.test(path)) throw new Error("Invalid Git common directory");
		configDir = await directory(physicalPath(gitDir, path));
	}
	await directory(join(configDir, "objects"));
	await directory(join(configDir, "refs"));
	const home = env.HOME ?? (process.platform === "win32" ? env.USERPROFILE : undefined);
	const globalFiles = process.platform === "win32" ? [] : ["/etc/gitconfig"];
	const xdg = env.XDG_CONFIG_HOME || (home ? join(home, ".config") : undefined);
	if (xdg) globalFiles.push(resolve(cwd, xdg, "git", "config"));
	if (home) globalFiles.push(resolve(cwd, home, ".gitconfig"));
	const worktreeConfig = join(gitDir, "config.worktree");
	let bare: boolean | undefined;
	const readConfig = async (file: string, worktree: boolean, depth = 0): Promise<void> => {
		if (depth > 10) throw new Error("Git config include depth exceeds the safe limit");
		const contents = await optionalFile(file);
		if (contents === undefined) return;
		let section = "";
		for (const line of contents.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || /^[#;]/.test(trimmed)) continue;
			const header = trimmed.match(/^\[([^\]]+)\]\s*(?:[#;].*)?$/);
			if (header) {
				section = header[1].trim().toLowerCase();
				if (/^includeif(?:\s|\.|$)/.test(section)) throw new Error("Git conditional config includes cannot be resolved safely");
				continue;
			}
			if (section === "include") {
				const match = trimmed.match(/^path\s*=\s*(.*)$/i);
				if (!match) throw new Error("Git config include cannot be resolved safely");
				await readConfig(includePath(match[1], file, home), worktree, depth + 1);
				continue;
			}
			if (section === "alias" && subcommand && trimmed.match(/^([^\s=]+)\s*(?:=|$)/)?.[1].toLowerCase() === subcommand.toLowerCase()) {
				throw new Error("Git aliases cannot be resolved safely");
			}
			if (section !== "core") continue;
			if (/^worktree\s*(?:=|$)/i.test(trimmed)) throw new Error("Git core.worktree config cannot be resolved safely");
			if (/^bare\s*(?:=|$)/i.test(trimmed)) {
				if (worktree) throw new Error("Git worktree-specific core.bare config cannot be resolved safely");
				const match = trimmed.match(/^bare(?:\s*=\s*(true|false|yes|no|on|off|1|0|"true"|"false"))?\s*(?:[#;].*)?$/i);
				if (!match) throw new Error("Git core.bare config cannot be resolved safely");
				bare = match[1] === undefined || ["true", "yes", "on", "1", '"true"'].includes(match[1].toLowerCase());
			}
		}
	};
	for (const file of [...globalFiles, join(configDir, "config"), worktreeConfig]) {
		await readConfig(file, file === worktreeConfig);
	}
	return bare;
}

export async function resolveCurrentGitTarget(cwd: string): Promise<{ gitDir: string; workTree?: string } | undefined> {
	try {
		let current = await directory(cwd);
		while (true) {
			if (await optionalFile(join(current, "HEAD")) !== undefined) {
				await validateMetadataDirectory(current);
				await directory(join(current, "objects"));
				await directory(join(current, "refs"));
				return { gitDir: current };
			}
			try {
				await stat(join(current, ".git"));
				return { gitDir: await metadataDirectory(join(current, ".git")), workTree: current };
			} catch (error: any) {
				if (error.code !== "ENOENT") throw error;
			}
			const parent = dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	} catch {
		return undefined;
	}
}

export async function analyzeGitInvocation(node: any, cwd?: string): Promise<GitInvocationAnalysis> {
	const segment = node.parent?.type === "redirected_statement" ? node.parent : node;
	const original = segment.text.trim();
	const fail = (error: string): GitInvocationAnalysis => ({ command: original, error });
	if (!cwd || !isAbsolute(cwd)) return fail("Git working directory is unknown");

	try {
		if (node.hasError) return fail("Git command has shell parse errors");
		const name = node.childForFieldName?.("name");
		if (!name || staticShellWord(name.text) !== "git") return fail("Git executable cannot be identified statically");
		const children: any[] = node.namedChildren ?? (node.children ?? []).filter((child: any) => child.isNamed);
		const assignments = children.filter((child) => child.type === "variable_assignment");
		const args = children.filter((child) => child !== name && child.type !== "variable_assignment" && child.type !== "file_redirect");
		const inheritedEnv: Record<string, string | undefined> = { ...process.env };
		const values = args.map((arg) => staticShellWord(arg.text, inheritedEnv));
		if (values.some((value) => value === undefined)) return fail("Git arguments use shell expansion");
		const argv = values as string[];
		const env = { ...inheritedEnv };
		const removed = new Set<any>();
		for (const assignment of assignments) {
			const match = assignment.text.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
			if (!match) return fail("Git environment assignment is ambiguous");
			const value = staticShellWord(match[2], env, "assignment");
			if (value === undefined) return fail("Git environment assignment uses shell expansion");
			env[match[1]] = value;
			if (match[1] === "GIT_DIR" || match[1] === "GIT_WORK_TREE") removed.add(assignment);
		}
		for (const key of Object.keys(env)) {
			if (env[key] !== undefined && key.startsWith("GIT_") && key !== "GIT_DIR" && key !== "GIT_WORK_TREE") {
				return fail(`Git environment variable ${key} cannot be resolved safely`);
			}
		}

		let effectiveCwd = await directory(cwd);
		let gitDirOption = env.GIT_DIR;
		let workTreeOption = env.GIT_WORK_TREE;
		let bare = false;
		let subcommand: string | undefined;
		for (let index = 0; index < argv.length; index += 1) {
			const arg = argv[index];
			if (!arg.startsWith("-") || arg === "-") {
				subcommand = arg;
				break;
			}
			if (arg === "--bare") {
				bare = true;
				gitDirOption = effectiveCwd;
				continue;
			}
			if (SAFE_GLOBAL_OPTIONS.has(arg)) continue;
			let option: "-C" | "--git-dir" | "--work-tree" | undefined;
			let value: string | undefined;
			if (arg === "-C" || arg === "--git-dir" || arg === "--work-tree") option = arg;
			else if (arg.startsWith("-C")) {
				option = "-C";
				value = arg.slice(2);
			} else if (arg.startsWith("--git-dir=")) {
				option = "--git-dir";
				value = arg.slice("--git-dir=".length);
			} else if (arg.startsWith("--work-tree=")) {
				option = "--work-tree";
				value = arg.slice("--work-tree=".length);
			}
			if (!option) return fail(`Git global option ${arg} cannot be resolved safely`);
			removed.add(args[index]);
			if (value === undefined) {
				index += 1;
				if (index >= argv.length) return fail(`Git ${option} requires a value`);
				value = argv[index];
				removed.add(args[index]);
			}
			if (option === "-C") {
				if (value !== "") effectiveCwd = await directory(physicalPath(effectiveCwd, value));
			} else if (option === "--git-dir") gitDirOption = value;
			else workTreeOption = value;
		}
		if (subcommand === "init" || subcommand === "clone") return fail(`Git ${subcommand} can select a new target`);
		if (subcommand !== undefined && !SUPPORTED_SUBCOMMANDS.has(subcommand)) return fail(`Git subcommand ${subcommand} cannot be resolved safely`);
		if (gitDirOption === "" || workTreeOption === "") return fail("Git target path is empty");
		if (bare && workTreeOption !== undefined) return fail("Git --bare and a work tree are ambiguous");

		let gitDir: string;
		let workTree: string | undefined;
		if (gitDirOption !== undefined || bare) {
			gitDir = await metadataDirectory(physicalPath(effectiveCwd, gitDirOption ?? "."));
			const configuredBare = await bareSetting(gitDir, effectiveCwd, env, subcommand);
			if (!bare && (workTreeOption !== undefined || configuredBare !== true)) {
				workTree = await directory(physicalPath(effectiveCwd, workTreeOption ?? "."));
			}
		} else {
			const discovered = await discover(effectiveCwd);
			gitDir = discovered.gitDir;
			if (workTreeOption !== undefined || (await bareSetting(gitDir, effectiveCwd, env, subcommand)) !== true) {
				workTree = workTreeOption === undefined ? discovered.workTree : await directory(physicalPath(effectiveCwd, workTreeOption));
			}
		}

		const commandParts = children.filter((child) => !removed.has(child)).map((child) => child === name ? "git" : child.text);
		if (segment !== node) {
			for (const child of segment.namedChildren ?? []) {
				if (child !== node) commandParts.push(child.text);
			}
		}
		return { command: commandParts.join(" "), target: workTree === undefined ? { gitDir } : { gitDir, workTree } };
	} catch (error: any) {
		return fail(error?.message ?? "Git target cannot be resolved safely");
	}
}
