import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// tree-sitter and tree-sitter-bash are CommonJS packages without consistently
// available TS declarations in extension runtimes, so load them lazily and
// keep their values typed as any.
type BashRuleScope = "session" | "directory" | "repo" | "global";
type PersistentBashRuleScope = Exclude<BashRuleScope, "session">;
type BashRuleList = "allow" | "deny";
type BashRule = {
	source: string;
	regex: RegExp;
	scope: BashRuleScope;
	list: BashRuleList;
	description?: string;
};
type StoredBashRule = string | { source?: unknown; description?: unknown };
type PermissionConfig = {
	version?: number;
	bash?: {
		allow?: StoredBashRule[];
		deny?: StoredBashRule[];
	};
	// Legacy/experimental shape support, if users created configs from early docs.
	bashAllowRules?: StoredBashRule[];
};
type RepoConfigLocation = {
	repoRoot: string;
	commonDir: string;
	configPath: string;
};
type LoadedConfigFile = {
	path: string;
	scope: PersistentBashRuleScope;
	config: PermissionConfig;
	allowRules: BashRule[];
	denyRules: BashRule[];
	errors: string[];
};
type LoadedConfigState = {
	cwd: string;
	global: LoadedConfigFile;
	directory: LoadedConfigFile;
	repo?: LoadedConfigFile;
	repoLocation?: RepoConfigLocation;
	allowRules: BashRule[];
	denyRules: BashRule[];
	errors: string[];
};
type LoadedSessionRuleState = {
	allowRules: BashRule[];
	denyRules: BashRule[];
	errors: string[];
};
type BashCommandRisk = {
	command: string;
	name: string;
	harmless: boolean;
	reason: string;
	splitter?: string;
};

type BashAnalysis = {
	parserAvailable: boolean;
	commands: BashCommandRisk[];
	error?: string;
};
type BashRuleDecision = { type: "allow" | "deny"; rule: BashRule };
type EvaluatedBashCommand = BashCommandRisk & {
	index: number;
	allowedOnce: boolean;
	ruleDecision?: BashRuleDecision;
};
type BashAnalysisEvaluation = {
	commands: EvaluatedBashCommand[];
	denied?: EvaluatedBashCommand;
	pendingDangerous: EvaluatedBashCommand[];
};
type BashSaveMode = "exact" | "regex";
type BashDialogDecision =
	| { type: "allow-once" }
	| { type: "block" }
	| { type: "save"; scope: BashRuleScope; mode: BashSaveMode };

const SESSION_RULES_ENTRY_TYPE = "tool-guard-session-rules";
const LEGACY_SESSION_RULES_ENTRY_TYPE = "simple-permissions-session-rules";
const WRITING_TOOLS = new Set(["write", "edit"]);
const READ_ONLY_COMMANDS = new Set([
	":",
	"true",
	"false",
	"pwd",
	"ls",
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"wc",
	"sort",
	"uniq",
	"cut",
	"diff",
	"cmp",
	"comm",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"awk",
	"sed",
	"find",
	"stat",
	"file",
	"du",
	"df",
	"ps",
	"date",
	"whoami",
	"id",
	"uname",
	"which",
	"whereis",
	"type",
	"command",
	"echo",
	"printf",
	"test",
	"[",
	"git",
]);
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
	"status",
	"diff",
	"log",
	"show",
	"branch",
	"tag",
	"rev-parse",
	"rev-list",
	"ls-files",
	"ls-tree",
	"grep",
	"blame",
	"remote",
]);
const FIND_MUTATING_FLAGS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf"]);
let bashParserPromise: Promise<{ parser: any | null; error?: string }> | undefined;
let configCache: LoadedConfigState | undefined;
let configLoadPromise: { cwd: string; promise: Promise<LoadedConfigState> } | undefined;
const extensionFilePath = fileURLToPath(import.meta.url);
const extensionDir = dirname(extensionFilePath);
const extensionFileRequire = createRequire(import.meta.url);
const DIRECT_MODULE_ENTRY_CANDIDATES: Record<string, string[]> = {
	"tree-sitter": ["node_modules/tree-sitter/index.js"],
	"tree-sitter-bash": ["node_modules/tree-sitter-bash/bindings/node/index.js"],
};

function collectRequireBases(): string[] {
	const seen = new Set<string>();
	const bases: string[] = [];
	const add = (value: string) => {
		const dir = resolve(value);
		if (seen.has(dir)) return;
		seen.add(dir);
		bases.push(dir);
	};

	add(extensionDir);
	add(resolve(extensionDir, ".."));
	add(process.cwd());

	for (const start of [...bases]) {
		let current = start;
		while (true) {
			add(current);
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}

	return bases;
}

function stripAtPrefix(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isInside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel));
}

async function realpathOrResolve(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

// Canonicalize existing paths, and for new files canonicalize the nearest
// existing parent. This prevents `cwd/link-to-/tmp/file` from being treated as
// inside CWD just because the textual path starts with CWD.
async function canonicalizeForPolicy(absolutePath: string): Promise<string> {
	let current = absolutePath;
	const missingParts: string[] = [];

	while (true) {
		try {
			const real = await realpath(current);
			return missingParts.length === 0 ? real : resolve(real, ...missingParts);
		} catch {
			const parent = dirname(current);
			if (parent === current) return resolve(absolutePath);
			missingParts.unshift(basename(current));
			current = parent;
		}
	}
}

function exactRuleSource(command: string): string {
	return `^${escapeRegExp(command)}$`;
}

function addRule(source: string, rules: BashRule[], scope: BashRuleScope, list: BashRuleList): BashRule {
	const rule = { source, regex: new RegExp(source), scope, list };
	rules.push(rule);
	return rule;
}

function addExactRule(command: string, rules: BashRule[], scope: BashRuleScope, list: BashRuleList): BashRule {
	return addRule(exactRuleSource(command), rules, scope, list);
}

function matchingBashRule(command: string, rules: BashRule[]): BashRule | undefined {
	return rules.find((rule) => {
		rule.regex.lastIndex = 0;
		return rule.regex.test(command);
	});
}

function getGlobalConfigPath(): string {
	return join(getAgentDir(), "extensions", "tool-guard.json");
}

function getLegacyGlobalConfigPath(): string {
	return join(getAgentDir(), "extensions", "simple-permissions.json");
}

function getDirectoryConfigPath(cwd: string): string {
	return resolve(cwd, ".pi", "tool-guard.json");
}

function getLegacyDirectoryConfigPath(cwd: string): string {
	return resolve(cwd, ".pi", "simple-permissions.json");
}

function getRepoConfigPath(commonDir: string): string {
	return resolve(commonDir, "pi-tool-guard.json");
}

function getLegacyRepoConfigPath(commonDir: string): string {
	return resolve(commonDir, "pi-simple-permissions.json");
}

async function loadRepoConfigLocation(cwd: string): Promise<{ location?: RepoConfigLocation; errors: string[] }> {
	let current = await realpathOrResolve(cwd);
	const errors: string[] = [];

	while (true) {
		const gitPath = join(current, ".git");
		try {
			const stat = await lstat(gitPath);
			if (stat.isDirectory()) {
				const commonDir = await realpathOrResolve(gitPath);
				return { location: { repoRoot: current, commonDir, configPath: getRepoConfigPath(commonDir) }, errors };
			}
			if (!stat.isFile()) {
				errors.push(`${gitPath}: ignored repo config: .git is neither a file nor a directory`);
				return { errors };
			}

			let gitDirSpec = "";
			try {
				gitDirSpec = await readFile(gitPath, "utf8");
			} catch (error: any) {
				errors.push(`${gitPath}: failed to read gitdir file: ${error.message}`);
				return { errors };
			}

			const match = gitDirSpec.match(/^gitdir:\s*(.+)\s*$/m);
			if (!match) {
				errors.push(`${gitPath}: ignored repo config: malformed gitdir file`);
				return { errors };
			}

			const gitDir = await realpathOrResolve(resolve(current, match[1]));
			let commonDir = gitDir;
			try {
				const commonDirSpec = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
				if (commonDirSpec) commonDir = await realpathOrResolve(resolve(gitDir, commonDirSpec));
			} catch (error: any) {
				if (error?.code !== "ENOENT") {
					errors.push(`${join(gitDir, "commondir")}: failed to read commondir: ${error.message}`);
				}
			}

			return { location: { repoRoot: current, commonDir, configPath: getRepoConfigPath(commonDir) }, errors };
		} catch (error: any) {
			if (error?.code !== "ENOENT") {
				errors.push(`${gitPath}: failed to inspect .git: ${error.message}`);
				return { errors };
			}
		}

		const parent = dirname(current);
		if (parent === current) return { errors };
		current = parent;
	}
}

function defaultConfig(): PermissionConfig {
	return { version: 1, bash: { allow: [], deny: [] } };
}

function normalizeConfig(value: unknown): PermissionConfig {
	const config = value && typeof value === "object" && !Array.isArray(value) ? (value as PermissionConfig) : defaultConfig();
	config.version ??= 1;
	config.bash = config.bash && typeof config.bash === "object" && !Array.isArray(config.bash) ? config.bash : {};
	config.bash.allow = Array.isArray(config.bash.allow) ? config.bash.allow : [];
	config.bash.deny = Array.isArray(config.bash.deny) ? config.bash.deny : [];
	if (Array.isArray(config.bashAllowRules) && config.bash.allow.length === 0) {
		config.bash.allow = config.bashAllowRules;
	}
	return config;
}

function storedRuleSource(entry: StoredBashRule): { source?: string; description?: string } {
	if (typeof entry === "string") return { source: entry };
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {};
	return {
		source: typeof entry.source === "string" ? entry.source : undefined,
		description: typeof entry.description === "string" ? entry.description : undefined,
	};
}

function compileStoredRules(
	entries: StoredBashRule[] | undefined,
	scope: BashRuleScope,
	list: BashRuleList,
	path: string,
): { rules: BashRule[]; errors: string[] } {
	const rules: BashRule[] = [];
	const errors: string[] = [];
	for (const [index, entry] of (entries ?? []).entries()) {
		const { source, description } = storedRuleSource(entry);
		if (!source) {
			errors.push(`${path}: ignored ${scope} ${list} rule #${index + 1}: missing string source`);
			continue;
		}
		try {
			rules.push({ source, regex: new RegExp(source), scope, list, description });
		} catch (error: any) {
			errors.push(`${path}: ignored ${scope} ${list} rule #${index + 1} /${source}/: ${error.message}`);
		}
	}
	return { rules, errors };
}

async function loadConfigFile(pathOrPaths: string | string[], scope: PersistentBashRuleScope): Promise<LoadedConfigFile> {
	const candidatePaths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];
	let parsed: unknown = defaultConfig();
	let loadedPath = candidatePaths[0]!;
	const errors: string[] = [];

	for (const path of candidatePaths) {
		loadedPath = path;
		try {
			parsed = JSON.parse(await readFile(path, "utf8"));
			break;
		} catch (error: any) {
			if (error?.code === "ENOENT") continue;
			errors.push(`${path}: failed to read config: ${error.message}`);
			parsed = defaultConfig();
			break;
		}
	}

	const config = normalizeConfig(parsed);
	const allow = compileStoredRules(config.bash?.allow, scope, "allow", loadedPath);
	const deny = compileStoredRules(config.bash?.deny, scope, "deny", loadedPath);
	return {
		path: loadedPath,
		scope,
		config,
		allowRules: allow.rules,
		denyRules: deny.rules,
		errors: [...errors, ...allow.errors, ...deny.errors],
	};
}

async function loadConfigs(cwd: string): Promise<LoadedConfigState> {
	if (configCache?.cwd === cwd) return configCache;
	if (configLoadPromise?.cwd === cwd) return configLoadPromise.promise;
	const promise = (async () => {
		const [globalConfig, directoryConfig, repoLocationResult] = await Promise.all([
			loadConfigFile([getGlobalConfigPath(), getLegacyGlobalConfigPath()], "global"),
			loadConfigFile([getDirectoryConfigPath(cwd), getLegacyDirectoryConfigPath(cwd)], "directory"),
			loadRepoConfigLocation(cwd),
		]);
		const repoConfig = repoLocationResult.location
			? await loadConfigFile([repoLocationResult.location.configPath, getLegacyRepoConfigPath(repoLocationResult.location.commonDir)], "repo")
			: undefined;
		const state: LoadedConfigState = {
			cwd,
			global: globalConfig,
			directory: directoryConfig,
			repo: repoConfig,
			repoLocation: repoLocationResult.location,
			// More-specific allow rules are checked first. Denies win regardless of scope.
			allowRules: [...directoryConfig.allowRules, ...(repoConfig?.allowRules ?? []), ...globalConfig.allowRules],
			denyRules: [...directoryConfig.denyRules, ...(repoConfig?.denyRules ?? []), ...globalConfig.denyRules],
			errors: [...globalConfig.errors, ...directoryConfig.errors, ...repoLocationResult.errors, ...(repoConfig?.errors ?? [])],
		};
		configCache = state;
		return state;
	})();
	configLoadPromise = { cwd, promise };
	try {
		return await promise;
	} finally {
		if (configLoadPromise?.promise === promise) configLoadPromise = undefined;
	}
}

function invalidateConfigCache() {
	configCache = undefined;
	configLoadPromise = undefined;
}

function loadSessionRules(ctx: any): LoadedSessionRuleState {
	const entries = ctx.sessionManager.getEntries();
	let latest: unknown;
	for (const entry of entries) {
		if (
			entry.type === "custom" &&
			(entry.customType === SESSION_RULES_ENTRY_TYPE || entry.customType === LEGACY_SESSION_RULES_ENTRY_TYPE)
		) latest = entry.data;
	}
	if (latest === undefined) return { allowRules: [], denyRules: [], errors: [] };

	const config = normalizeConfig(latest);
	const allow = compileStoredRules(config.bash?.allow, "session", "allow", "session tool-guard entry");
	const deny = compileStoredRules(config.bash?.deny, "session", "deny", "session tool-guard entry");
	return { allowRules: allow.rules, denyRules: deny.rules, errors: [...allow.errors, ...deny.errors] };
}

function persistedSessionRules(allowRules: BashRule[], denyRules: BashRule[]): PermissionConfig {
	return {
		version: 1,
		bash: {
			allow: allowRules.map((rule) => ({ source: rule.source })),
			deny: denyRules.map((rule) => ({ source: rule.source })),
		},
	};
}

async function saveConfigFile(path: string, config: PermissionConfig) {
	await mkdir(dirname(path), { recursive: true });
	const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmpPath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
	await rename(tmpPath, path);
}

async function resolvePersistentConfigPath(ctx: any, scope: PersistentBashRuleScope): Promise<string> {
	if (scope === "global") return getGlobalConfigPath();
	if (scope === "directory") return getDirectoryConfigPath(ctx.cwd);
	const config = await loadConfigs(ctx.cwd);
	if (!config.repoLocation) throw new Error("Not inside a Git repository; repo scope is unavailable");
	return config.repoLocation.configPath;
}

async function addPersistentRule(ctx: any, scope: PersistentBashRuleScope, list: BashRuleList, source: string) {
	// Validate before saving so a typo cannot poison every future session.
	new RegExp(source);
	const path = await resolvePersistentConfigPath(ctx, scope);
	const file = await loadConfigFile(path, scope);
	file.config.bash ??= { allow: [], deny: [] };
	file.config.bash.allow ??= [];
	file.config.bash.deny ??= [];
	file.config.bash[list]!.push({ source });
	await saveConfigFile(path, file.config);
	invalidateConfigCache();
}

async function clearPersistentRule(ctx: any, scope: PersistentBashRuleScope, list: BashRuleList, target: string) {
	const path = await resolvePersistentConfigPath(ctx, scope);
	const file = await loadConfigFile(path, scope);
	file.config.bash ??= { allow: [], deny: [] };
	file.config.bash.allow ??= [];
	file.config.bash.deny ??= [];
	const rules = file.config.bash[list]!;
	if (target === "all") {
		rules.splice(0, rules.length);
	} else {
		const index = Number(target) - 1;
		if (!Number.isInteger(index) || index < 0 || index >= rules.length) {
			throw new Error(`No ${scope} ${list} rule #${target}`);
		}
		rules.splice(index, 1);
	}
	await saveConfigFile(path, file.config);
	invalidateConfigCache();
}

function ruleLabel(rule: BashRule): string {
	return `${rule.scope} ${rule.list} rule /${rule.source}/`;
}

function formatDisplayedBashCommand(command: Pick<BashCommandRisk, "command" | "splitter">): string {
	return `${command.splitter ? `${command.splitter} ` : ""}${command.command}`;
}

function bashRuleDecisionForCommand(
	command: string,
	sessionAllowRules: BashRule[],
	sessionDenyRules: BashRule[],
	config: LoadedConfigState,
): BashRuleDecision | undefined {
	const deny = matchingBashRule(command, [...sessionDenyRules, ...config.denyRules]);
	if (deny) return { type: "deny", rule: deny };
	const allow = matchingBashRule(command, [...sessionAllowRules, ...config.allowRules]);
	if (allow) return { type: "allow", rule: allow };
	return undefined;
}

function evaluateBashAnalysis(
	analysis: BashAnalysis,
	allowedOnceIndexes: Set<number>,
	sessionAllowRules: BashRule[],
	sessionDenyRules: BashRule[],
	config: LoadedConfigState,
): BashAnalysisEvaluation {
	const commands = analysis.commands.map((item, index) => ({
		...item,
		index,
		allowedOnce: allowedOnceIndexes.has(index),
		ruleDecision: bashRuleDecisionForCommand(item.command, sessionAllowRules, sessionDenyRules, config),
	}));
	const denied = commands.find((item) => item.ruleDecision?.type === "deny");
	const pendingDangerous = commands.filter((item) => !item.harmless && !item.allowedOnce && item.ruleDecision?.type !== "allow" && item.ruleDecision?.type !== "deny");
	return { commands, denied, pendingDangerous };
}

async function confirmFileMutation(ctx: any, toolName: string, requestedPath: string, targetReal: string, cwdReal: string) {
	if (!ctx.hasUI) return { block: true, reason: `Write/edit outside CWD blocked: ${targetReal}` } as const;

	const ok = await ctx.ui.confirm(
		"Allow write outside CWD?",
		`Tool: ${toolName}\nRequested path: ${requestedPath}\nResolved path: ${targetReal}\nCWD: ${cwdReal}\n\nAllow this file mutation?`,
	);

	return ok ? undefined : ({ block: true, reason: "Blocked by user" } as const);
}

function withBunCompat<T>(load: () => T): T {
	if (typeof process.versions.bun !== "string") return load();

	const versions = process.versions as NodeJS.ProcessVersions & { bun?: string };
	const descriptor = Object.getOwnPropertyDescriptor(versions, "bun");
	const hadBun = Object.prototype.hasOwnProperty.call(versions, "bun");
	const bunVersion = versions.bun;

	try {
		if (descriptor?.writable) versions.bun = undefined;
		else if (descriptor?.configurable) delete versions.bun;
		return load();
	} finally {
		if (!hadBun) return;
		if (descriptor) Object.defineProperty(versions, "bun", { ...descriptor, value: bunVersion });
		else if (bunVersion) versions.bun = bunVersion;
	}
}

function tryLoadWithRequire(requireFn: NodeJS.Require, request: string, attempted: string[], lastErrorRef: { value: unknown }) {
	attempted.push(request);
	try {
		return { loaded: true as const, value: requireFn(request) };
	} catch (error) {
		lastErrorRef.value = error;
		return { loaded: false as const };
	}
}

function resolveDirectModuleEntryPaths(moduleName: string, bases: string[]): string[] {
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const relativeEntry of DIRECT_MODULE_ENTRY_CANDIDATES[moduleName] ?? []) {
		for (const base of bases) {
			const entryPath = join(base, relativeEntry);
			if (!existsSync(entryPath) || seen.has(entryPath)) continue;
			seen.add(entryPath);
			paths.push(entryPath);
		}
	}
	return paths;
}

function requireExtensionDependency(moduleName: string): any {
	return withBunCompat(() => {
		const attempted: string[] = [];
		const lastErrorRef: { value: unknown } = { value: undefined };
		const bases = collectRequireBases();

		for (const base of bases) {
			const packageJsonPath = join(base, "package.json");
			if (!existsSync(packageJsonPath)) continue;
			const result = tryLoadWithRequire(createRequire(packageJsonPath), moduleName, attempted, lastErrorRef);
			if (result.loaded) return result.value;
		}

		const extensionResult = tryLoadWithRequire(extensionFileRequire, moduleName, attempted, lastErrorRef);
		if (extensionResult.loaded) return extensionResult.value;

		for (const entryPath of resolveDirectModuleEntryPaths(moduleName, bases)) {
			const result = tryLoadWithRequire(extensionFileRequire, entryPath, attempted, lastErrorRef);
			if (result.loaded) return result.value;
		}

		const detail = lastErrorRef.value instanceof Error ? (lastErrorRef.value.stack ?? lastErrorRef.value.message) : String(lastErrorRef.value);
		throw new Error(`Unable to load ${moduleName}. Attempted roots:\n${attempted.join("\n")}\n\nLast error: ${detail}`);
	});
}

function moduleDefault<T>(value: T): T {
	return ((value as any)?.default ?? value) as T;
}

function mutableModuleExports<T extends object>(value: T): T {
	return Object.assign({}, value);
}

async function getBashParser(): Promise<{ parser: any | null; error?: string }> {
	bashParserPromise ??= (async () => {
		try {
			const Parser = moduleDefault<any>(requireExtensionDependency("tree-sitter"));
			// Bun can freeze ESM namespace objects. tree-sitter mutates the language
			// object during setLanguage(), so clone exports into a plain mutable object.
			const Bash = mutableModuleExports(moduleDefault<any>(requireExtensionDependency("tree-sitter-bash")));
			const parser = new Parser();
			parser.setLanguage(Bash);
			return { parser };
		} catch (error: any) {
			return { parser: null, error: error?.stack ?? error?.message ?? String(error) };
		}
	})();
	return bashParserPromise;
}

function stripShellQuotes(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === "'" && last === "'") || (first === '"' && last === '"')) return value.slice(1, -1);
	}
	return value;
}

function hasWritingRedirectNode(node: any): boolean {
	if (node.type === "file_redirect") {
		return (node.children ?? []).some((child: any) => [">", ">>", "&>", "&>>", "<>", ">&"].includes(child.type));
	}
	return (node.children ?? []).some((child: any) => hasWritingRedirectNode(child));
}

function getCommandName(node: any): string | null {
	const fieldName = node.childForFieldName?.("name");
	if (fieldName?.text) return stripShellQuotes(fieldName.text).toLowerCase();

	for (const child of node.children ?? []) {
		if (child.type === "variable_assignment") continue;
		if (child.type === "command_name" || child.type === "word") return stripShellQuotes(child.text).toLowerCase();
	}
	return null;
}

function getCommandArgs(node: any): string[] {
	const args: string[] = [];
	let foundName = false;
	for (const child of node.children ?? []) {
		if (child.type === "variable_assignment") continue;
		if (!foundName && (child.type === "command_name" || child.type === "word")) {
			foundName = true;
			continue;
		}
		if (["word", "string", "raw_string", "number", "concatenation", "expansion"].includes(child.type)) {
			args.push(stripShellQuotes(child.text));
		}
	}
	return args;
}

function getCommandSegmentNode(node: any): any {
	return node.parent?.type === "redirected_statement" ? node.parent : node;
}

function riskForCommand(node: any, splitter?: string): BashCommandRisk {
	const segmentNode = getCommandSegmentNode(node);
	const command = segmentNode.text.trim();
	const name = getCommandName(node) ?? "assignment";
	const args = getCommandArgs(node);
	const withSplitter = (risk: Omit<BashCommandRisk, "splitter">): BashCommandRisk =>
		splitter ? { ...risk, splitter } : risk;

	if (hasWritingRedirectNode(segmentNode)) {
		return withSplitter({ command, name, harmless: false, reason: "writes via shell redirection" });
	}
	if (name === "assignment") return withSplitter({ command, name, harmless: true, reason: "variable assignment only" });
	if (!READ_ONLY_COMMANDS.has(name)) return withSplitter({ command, name, harmless: false, reason: `unknown or mutating command: ${name}` });

	if (name === "git") {
		const subcommand = args.find((arg) => !arg.startsWith("-"));
		if (!subcommand) return withSplitter({ command, name, harmless: true, reason: "git without mutating subcommand" });
		return GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)
			? withSplitter({ command, name, harmless: true, reason: `read-only git ${subcommand}` })
			: withSplitter({ command, name, harmless: false, reason: `potentially mutating git ${subcommand}` });
	}

	if (name === "find") {
		const mutatingFlag = args.find((arg) => FIND_MUTATING_FLAGS.has(arg));
		return mutatingFlag
			? withSplitter({ command, name, harmless: false, reason: `find uses ${mutatingFlag}` })
			: withSplitter({ command, name, harmless: true, reason: "find without mutating actions" });
	}

	if (name === "sed") {
		const mutatingFlag = args.find((arg) => arg === "-i" || arg.startsWith("-i"));
		const writesFile = args.some((arg) => /(^|;)\s*w\s+\S+/.test(arg));
		if (mutatingFlag) return withSplitter({ command, name, harmless: false, reason: "sed in-place edit" });
		if (writesFile) return withSplitter({ command, name, harmless: false, reason: "sed write command" });
	}

	if (name === "awk" && args.some((arg) => /system\s*\(/.test(arg) || />/.test(arg))) {
		return withSplitter({ command, name, harmless: false, reason: "awk may execute commands or write files" });
	}

	if (name === "command" && !(args[0] === "-v" || args[0] === "-V")) {
		return withSplitter({ command, name, harmless: false, reason: "command builtin may dispatch a mutating command" });
	}

	return withSplitter({ command, name, harmless: true, reason: "known read-only command" });
}

function collectCommandNodes(node: any, output: any[]) {
	if (node.type === "command" || node.type === "declaration_command") {
		output.push(node);
	}
	for (const child of node.children ?? []) collectCommandNodes(child, output);
}

async function analyzeBash(command: string): Promise<BashAnalysis> {
	const { parser, error: loadError } = await getBashParser();
	if (!parser) {
		return {
			parserAvailable: false,
			error: loadError,
			commands: [{ command, name: "unknown", harmless: false, reason: `tree-sitter bash parser unavailable${loadError ? `: ${loadError.split("\n")[0]}` : ""}` }],
		};
	}

	try {
		const tree = parser.parse(command);
		const nodes: any[] = [];
		collectCommandNodes(tree.rootNode, nodes);
		const sortedNodes = nodes.sort((a, b) => a.startIndex - b.startIndex);
		let previousEnd = 0;
		const commands = sortedNodes.map((node) => {
			const splitter = command.slice(previousEnd, node.startIndex).trim();
			previousEnd = getCommandSegmentNode(node).endIndex;
			return riskForCommand(node, splitter || undefined);
		});
		return { parserAvailable: true, commands };
	} catch (error: any) {
		return {
			parserAvailable: false,
			error: error?.message,
			commands: [{ command, name: "unknown", harmless: false, reason: "failed to parse bash command" }],
		};
	}
}

function formatBashAnalysis(analysis: BashAnalysis): string {
	const normal = "\x1b[0m";
	const warningBold = "\x1b[1;33m";
	if (analysis.commands.length === 0) return `${normal}✅ No executable commands detected`;
	const lines = analysis.commands.map((item) => {
		const prefix = item.harmless ? "✅" : "⚠️";
		const splitter = item.splitter ? `${item.splitter} ` : "";
		const command = `${splitter}${item.command}`;
		return item.harmless ? `${normal}${prefix} ${command}` : `${normal}${prefix} ${warningBold}${command}${normal}`;
	});
	if (!analysis.parserAvailable && analysis.error) lines.push(`${normal}⚠️ ${warningBold}Parser error: ${analysis.error}${normal}`);
	return lines.join("\n");
}

async function selectBashDecision(
	ctx: any,
	evaluation: BashAnalysisEvaluation,
	analysis: BashAnalysis,
	targetIndex: number,
	config: LoadedConfigState,
	initialStage: "action" | "save" = "action",
): Promise<BashDialogDecision | undefined> {
	const actionChoices = ["Allow once", "Deny", "Save allow rule…"];
	const scopeChoices: BashRuleScope[] = ["session", "directory", ...(config.repoLocation ? (["repo"] as const) : []), "global"];

	return ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: (value: BashDialogDecision | undefined) => void) => {
		let stage: "action" | "save" = initialStage;
		let actionSelected = 0;
		let scopeSelected = 0;
		let saveMode: BashSaveMode = "exact";
		const ansiPattern = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[PX^_].*?\x1b\\|.)/;
		const charWidth = (char: string) => {
			const code = char.codePointAt(0) ?? 0;
			if ((code >= 0x300 && code <= 0x36f) || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
			if (
				(code >= 0x1100 && code <= 0x115f) ||
				(code >= 0x2329 && code <= 0x232a) ||
				(code >= 0x2600 && code <= 0x27bf) ||
				(code >= 0x2e80 && code <= 0xa4cf) ||
				(code >= 0xac00 && code <= 0xd7a3) ||
				(code >= 0xf900 && code <= 0xfaff) ||
				(code >= 0xfe10 && code <= 0xfe19) ||
				(code >= 0xfe30 && code <= 0xfe6f) ||
				(code >= 0xff00 && code <= 0xff60) ||
				(code >= 0xffe0 && code <= 0xffe6) ||
				(code >= 0x1f300 && code <= 0x1faff)
			) return 2;
			return 1;
		};
		const visibleWidth = (value: string) => {
			let width = 0;
			for (let index = 0; index < value.length;) {
				const ansi = value.slice(index).match(ansiPattern);
				if (ansi) {
					index += ansi[0].length;
					continue;
				}
				const char = Array.from(value.slice(index))[0] ?? "";
				width += charWidth(char);
				index += char.length;
			}
			return width;
		};
		const pad = (value: string, width: number) => `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
		const wrapPlain = (value: string, width: number) => {
			const wrapped: string[] = [];
			for (const sourceLine of value.split(/\r?\n/)) {
				if (sourceLine.length === 0) {
					wrapped.push("");
					continue;
				}

				let current = "";
				let used = 0;
				for (let index = 0; index < sourceLine.length;) {
					const char = Array.from(sourceLine.slice(index))[0] ?? "";
					const nextWidth = charWidth(char);
					if (current.length > 0 && used + nextWidth > width) {
						wrapped.push(current);
						current = "";
						used = 0;
						continue;
					}
					current += char;
					used += nextWidth;
					index += char.length;
					if (used >= width) {
						wrapped.push(current);
						current = "";
						used = 0;
					}
				}
				if (current.length > 0) wrapped.push(current);
			}
			return wrapped.length > 0 ? wrapped : [""];
		};
		const wrapPrefixed = (prefix: string, content: string, width: number, style: (value: string) => string = (value) => value) => {
			const prefixWidth = visibleWidth(prefix);
			const continuationPrefix = " ".repeat(prefixWidth);
			const contentWidth = Math.max(1, width - prefixWidth);
			const wrappedContent = wrapPlain(content, contentWidth);
			return wrappedContent.map((line, index) => `${index === 0 ? prefix : continuationPrefix}${style(line)}`);
		};
		const linesForCommand = (item: EvaluatedBashCommand, width: number) => {
			const active = stage === "save" && item.index === targetIndex;
			const approved = item.harmless || item.allowedOnce || item.ruleDecision?.type === "allow";
			const text = formatDisplayedBashCommand(item);
			const prefix = active ? (approved ? "→ ✅ " : "→ ⚠️ ") : approved ? "✅ " : "⚠️ ";
			if (approved) {
				return wrapPrefixed(prefix, text, width, (value) => (active ? theme.fg("accent", value) : value));
			}
			return wrapPrefixed(prefix, text, width, (value) => (active ? theme.fg("warning", theme.bold(value)) : theme.fg("warning", value)));
		};
		const scopeLabel = (scope: BashRuleScope) => `${scope[0]!.toUpperCase()}${scope.slice(1)}`;
		const modeLabel = (mode: BashSaveMode, label: string) => {
			const active = saveMode === mode;
			const prefix = active ? "◉ " : "○ ";
			const text = `${prefix}${label}`;
			return active ? theme.fg("accent", text) : theme.fg("muted", text);
		};
		const wrapInlineChoices = (choices: string[], selectedIndex: number, width: number) => {
			const lines: string[] = [];
			let current = "";
			let currentWidth = 0;
			for (const [index, choice] of choices.entries()) {
				const plain = index === selectedIndex ? `[${choice}]` : choice;
				const rendered =
					index === selectedIndex ? theme.fg("accent", theme.bold(plain)) : theme.fg("muted", plain);
				const separator = current.length === 0 ? "" : "  ";
				const nextWidth = currentWidth + (separator ? visibleWidth(separator) : 0) + visibleWidth(plain);
				if (current.length > 0 && nextWidth > width) {
					lines.push(current);
					current = rendered;
					currentWidth = visibleWidth(plain);
					continue;
				}
				current += `${separator}${rendered}`;
				currentWidth = nextWidth;
			}
			if (current.length > 0) lines.push(current);
			return lines;
		};

		return {
			render: (width: number) => {
				const boxWidth = Math.max(24, width - 12);
				const innerWidth = Math.max(1, boxWidth - 4);
				const border = (left: string, fill: string, right: string) => theme.fg("borderAccent", `${left}${fill.repeat(innerWidth + 2)}${right}`);
				const divider = theme.fg("borderAccent", "─".repeat(innerWidth));
				const boxed = (line: string) => theme.fg("borderAccent", "│ ") + pad(line, innerWidth) + theme.fg("borderAccent", " │");
				const stageLines =
					stage === "action"
						? [
							...wrapInlineChoices(actionChoices, actionSelected, innerWidth),
							...wrapPrefixed("", "Allow once approves the whole bash command.", innerWidth, (value) => theme.fg("dim", value)),
							"",
							...wrapPrefixed("", "←→ or ↑↓ navigate   enter select   escape/ctrl+c cancel", innerWidth, (value) => theme.fg("dim", value)),
						]
						: [
							theme.fg("accent", theme.bold("Save allow rule")),
							...wrapPrefixed("", "Applies to the highlighted sub-command. Tab or ←→ switches exact/regex. ↑↓ chooses scope.", innerWidth, (value) => theme.fg("dim", value)),
							"",
							theme.fg("accent", "Mode:"),
							`  ${modeLabel("exact", "Exact command")}`,
							`  ${modeLabel("regex", "Regex rule")}`,
							"",
							theme.fg("accent", "Scope:"),
							...scopeChoices.flatMap((scope, index) =>
								wrapPrefixed(
									`${index === scopeSelected ? "→" : " "} `,
									scopeLabel(scope),
									innerWidth,
									(value) => (index === scopeSelected ? theme.fg("accent", value) : value),
								),
							),
							"",
							...wrapPrefixed("", "enter save   escape back   ctrl+c cancel", innerWidth, (value) => theme.fg("dim", value)),
						];
				const lines = [
					theme.fg("accent", theme.bold(stage === "action" ? "Allow bash command?" : "Save allow rule for highlighted sub-command")),
					...(evaluation.commands.length === 0 ? ["✅ No executable commands detected"] : evaluation.commands.flatMap((item) => linesForCommand(item, innerWidth))),
					...(analysis.parserAvailable || !analysis.error
						? []
						: [divider, ...wrapPrefixed("⚠️ Parser error: ", analysis.error, innerWidth, (value) => theme.fg("warning", theme.bold(value)))]),
					"",
					...stageLines,
				];
				return [border("╭", "─", "╮"), ...lines.map(boxed), border("╰", "─", "╯")];
			},
			 handleInput: (data: string) => {
				if (stage === "action") {
					if (data === "\x1b[A" || data === "\x1b[D") actionSelected = Math.max(0, actionSelected - 1);
					else if (data === "\x1b[B" || data === "\x1b[C") actionSelected = Math.min(actionChoices.length - 1, actionSelected + 1);
					else if (data === "\r" || data === "\n") {
						if (actionSelected === 0) return done({ type: "allow-once" });
						if (actionSelected === 1) return done({ type: "block" });
						stage = "save";
					} else if (data === "\x1b" || data === "\x03") return done(undefined);
					tui.requestRender();
					return;
				}

				if (data === "\x1b[A") scopeSelected = Math.max(0, scopeSelected - 1);
				else if (data === "\x1b[B") scopeSelected = Math.min(scopeChoices.length - 1, scopeSelected + 1);
				else if (data === "\t" || data === "\x1b[C" || data === "\x1b[D" || data === "\x1b[Z") {
					saveMode = saveMode === "exact" ? "regex" : "exact";
				} else if (data === "\r" || data === "\n") return done({ type: "save", scope: scopeChoices[scopeSelected]!, mode: saveMode });
				else if (data === "\x1b") stage = "action";
				else if (data === "\x03") return done(undefined);
				tui.requestRender();
			},
			invalidate: () => {},
		};
	}, { overlay: true });
}

async function confirmBash(
	ctx: any,
	command: string,
	bashAllowRules: BashRule[],
	bashDenyRules: BashRule[],
	config: LoadedConfigState,
	onSessionRulesChanged: () => void = () => {},
) {
	let activeConfig = config;
	const analysis = await analyzeBash(command);
	const allHarmless = analysis.commands.every((item) => item.harmless);
	if (allHarmless) {
		const harmlessEvaluation = evaluateBashAnalysis(analysis, new Set<number>(), bashAllowRules, bashDenyRules, activeConfig);
		if (harmlessEvaluation.denied) {
			return {
				block: true,
				reason: `Bash sub-command denied by ${ruleLabel(harmlessEvaluation.denied.ruleDecision!.rule)}: ${formatDisplayedBashCommand(harmlessEvaluation.denied)}`,
			} as const;
		}
		if (ctx.hasUI) ctx.ui.notify(`Allowed harmless bash command:\n${formatBashAnalysis(analysis)}`, "info");
		return undefined;
	}

	const allowedOnceIndexes = new Set<number>();
	let promptStage: "action" | "save" = "action";
	while (true) {
		const evaluation = evaluateBashAnalysis(analysis, allowedOnceIndexes, bashAllowRules, bashDenyRules, activeConfig);
		if (evaluation.denied) {
			return {
				block: true,
				reason: `Bash sub-command denied by ${ruleLabel(evaluation.denied.ruleDecision!.rule)}: ${formatDisplayedBashCommand(evaluation.denied)}`,
			} as const;
		}
		if (evaluation.pendingDangerous.length === 0) return undefined;

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Bash command blocked because no UI is available to approve dangerous sub-commands.\n${formatBashAnalysis(analysis)}`,
			} as const;
		}

		const target = evaluation.pendingDangerous[0]!;
		const decision = await selectBashDecision(ctx, evaluation, analysis, target.index, activeConfig, promptStage);
		promptStage = "action";
		if (!decision || decision.type === "block") return { block: true, reason: "Blocked by user" } as const;
		if (decision.type === "allow-once") return undefined;

		if (decision.mode === "exact") {
			if (decision.scope === "session") {
				addExactRule(target.command, bashAllowRules, "session", "allow");
				onSessionRulesChanged();
				ctx.ui.notify("Added exact bash allow rule for this sub-command in this session.", "info");
				promptStage = "save";
				continue;
			}

			try {
				await addPersistentRule(ctx, decision.scope, "allow", exactRuleSource(target.command));
				activeConfig = await loadConfigs(ctx.cwd);
				ctx.ui.notify(`Added exact bash allow rule for this sub-command in ${decision.scope} scope.`, "info");
				promptStage = "save";
				continue;
			} catch (error: any) {
				ctx.ui.notify(`Could not save ${decision.scope} rule: ${error.message}`, "error");
				return { block: true, reason: `Could not save ${decision.scope} rule: ${error.message}` } as const;
			}
		}

		const source = await ctx.ui.input("Bash allow regex for sub-command", "Example: ^ssh\\b");
		if (!source) return { block: true, reason: "Blocked by user" } as const;

		try {
			const regex = new RegExp(source);
			if (decision.scope === "session") {
				bashAllowRules.push({ source, regex, scope: "session", list: "allow" });
				onSessionRulesChanged();
				ctx.ui.notify(`Added session bash allow rule for sub-commands: /${source}/`, "info");
			} else {
				await addPersistentRule(ctx, decision.scope, "allow", source);
				activeConfig = await loadConfigs(ctx.cwd);
				ctx.ui.notify(`Added ${decision.scope} bash allow rule for sub-commands: /${source}/`, "info");
			}

			regex.lastIndex = 0;
			if (regex.test(target.command)) {
				promptStage = "save";
				continue;
			}
			return { block: true, reason: `Added regex /${source}/ does not match this sub-command: ${target.command}` } as const;
		} catch (error: any) {
			ctx.ui.notify(`Invalid regex: ${error.message}`, "error");
			return { block: true, reason: `Invalid regex: ${error.message}` } as const;
		}
	}
}

export default function toolGuard(pi: ExtensionAPI) {
	const bashAllowRules: BashRule[] = [];
	const bashDenyRules: BashRule[] = [];
	let sessionRuleErrors: string[] = [];

	const saveSessionRules = () => {
		sessionRuleErrors = [];
		pi.appendEntry(SESSION_RULES_ENTRY_TYPE, persistedSessionRules(bashAllowRules, bashDenyRules));
	};

	const replaceSessionRules = (allowRules: BashRule[], denyRules: BashRule[]) => {
		bashAllowRules.splice(0, bashAllowRules.length, ...allowRules);
		bashDenyRules.splice(0, bashDenyRules.length, ...denyRules);
	};

	const splitOptionalScope = (raw: string): { scope: BashRuleScope; value: string } => {
		const trimmed = raw.trim();
		const match = trimmed.match(/^(session|directory|repo|global)(?:\s+|$)/);
		if (!match) return { scope: "session", value: trimmed };
		return { scope: match[1] as BashRuleScope, value: trimmed.slice(match[0].length).trim() };
	};

	const addScopedRule = async (ctx: any, scope: BashRuleScope, list: BashRuleList, source: string) => {
		if (scope === "session") {
			const rules = list === "allow" ? bashAllowRules : bashDenyRules;
			addRule(source, rules, "session", list);
			saveSessionRules();
			ctx.ui.notify(`Added session bash ${list} rule #${rules.length}: /${source}/`, "info");
			return;
		}
		await addPersistentRule(ctx, scope, list, source);
		ctx.ui.notify(`Added ${scope} bash ${list} rule: /${source}/`, "info");
	};

	const registerRuleCommand = (name: string, list: BashRuleList, exact: boolean) => {
		pi.registerCommand(name, {
			description: `${list === "allow" ? "Allow" : "Deny"} ${exact ? "one exact" : "matching"} bash sub-command${exact ? "" : "s"}. Usage: /${name} [session|directory|repo|global] <${exact ? "command" : "regex"}>`,
			handler: async (args, ctx) => {
				const { scope, value } = splitOptionalScope(args);
				if (!value) {
					ctx.ui.notify(`Usage: /${name} [session|directory|repo|global] <${exact ? "command" : "regex"}>`, "warning");
					return;
				}

				try {
					await addScopedRule(ctx, scope, list, exact ? exactRuleSource(value) : value);
				} catch (error: any) {
					ctx.ui.notify(`Could not add ${scope} ${list} rule: ${error.message}`, "error");
				}
			},
		});
	};

	registerRuleCommand("guard-allow", "allow", false);
	registerRuleCommand("guard-allow-exact", "allow", true);
	registerRuleCommand("guard-deny", "deny", false);
	registerRuleCommand("guard-deny-exact", "deny", true);

	pi.registerCommand("guard-list", {
		description: "List bash allow/deny rules. Usage: /guard-list [all|session|directory|repo|global]",
		handler: async (args, ctx) => {
			const scope = args.trim() || "all";
			if (!["all", "session", "directory", "repo", "global"].includes(scope)) {
				ctx.ui.notify("Usage: /guard-list [all|session|directory|repo|global]", "warning");
				return;
			}

			const config = await loadConfigs(ctx.cwd);
			const sections: string[] = [];
			const addSection = (title: string, rules: BashRule[]) => {
				if (rules.length === 0) return false;
				sections.push(`${title}:`);
				sections.push(...rules.map((rule, index) => `  ${index + 1}. /${rule.source}/${rule.description ? ` — ${rule.description}` : ""}`));
				return true;
			};
			const addScopedSections = (title: string, allowRules: BashRule[], denyRules: BashRule[], path?: string) => {
				if (allowRules.length === 0 && denyRules.length === 0) return false;
				if (path) sections.push(`${title} config: ${path}`);
				addSection(`${title} allow`, allowRules);
				addSection(`${title} deny`, denyRules);
				return true;
			};

			if (scope === "all" || scope === "session") {
				addScopedSections("Session", bashAllowRules, bashDenyRules);
			}
			if (scope === "all" || scope === "directory") {
				addScopedSections("Directory", config.directory.allowRules, config.directory.denyRules, config.directory.path);
			}
			if (scope === "all" || scope === "repo") {
				if (config.repo) addScopedSections("Repo", config.repo.allowRules, config.repo.denyRules, config.repo.path);
				else if (scope === "repo") sections.push("No Git repo detected for repo-scoped rules.");
			}
			if (scope === "all" || scope === "global") {
				addScopedSections("Global", config.global.allowRules, config.global.denyRules, config.global.path);
			}
			const warnings = [...sessionRuleErrors, ...config.errors];
			if (warnings.length > 0) sections.push("", "Warnings:", ...warnings.map((error) => `  ${error}`));

			ctx.ui.notify(sections.length === 0 ? "No bash rules." : sections.join("\n"), "info");
		},
	});

	pi.registerCommand("guard-clear", {
		description: "Clear bash rules. Usage: /guard-clear [session|directory|repo|global] [all|allow|deny|number] [all|number]",
		handler: async (args, ctx) => {
			const { scope, value } = splitOptionalScope(args);
			const parts = value.split(/\s+/).filter(Boolean);
			const clearSessionRules = (rules: BashRule[], list: BashRuleList, target: string | undefined) => {
				if (!target || target === "all") {
					rules.splice(0, rules.length);
					saveSessionRules();
					ctx.ui.notify(`Cleared session bash ${list} rules.`, "info");
					return;
				}
				const index = Number(target) - 1;
				if (!Number.isInteger(index) || index < 0 || index >= rules.length) {
					ctx.ui.notify("Usage: /guard-clear [session|directory|repo|global] [all|allow|deny|number] [all|number]", "warning");
					return;
				}
				const [removed] = rules.splice(index, 1);
				saveSessionRules();
				ctx.ui.notify(`Removed session ${list} rule: /${removed.source}/`, "info");
			};

			if (scope === "session") {
				if (parts.length === 0 || parts[0] === "all") {
					bashAllowRules.splice(0, bashAllowRules.length);
					bashDenyRules.splice(0, bashDenyRules.length);
					saveSessionRules();
					ctx.ui.notify("Cleared all session bash rules.", "info");
					return;
				}
				if (parts[0] === "allow") return clearSessionRules(bashAllowRules, "allow", parts[1]);
				if (parts[0] === "deny") return clearSessionRules(bashDenyRules, "deny", parts[1]);
				return clearSessionRules(bashAllowRules, "allow", parts[0]);
			}

			const [list, target] = parts;
			if ((list !== "allow" && list !== "deny") || !target) {
				ctx.ui.notify("Usage: /guard-clear <directory|repo|global> <allow|deny> <all|number>", "warning");
				return;
			}
			try {
				await clearPersistentRule(ctx, scope, list, target);
				ctx.ui.notify(`Cleared ${scope} ${list} rule${target === "all" ? "s" : ` #${target}`}.`, "info");
			} catch (error: any) {
				ctx.ui.notify(`Could not clear ${scope} rule: ${error.message}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const session = loadSessionRules(ctx);
		replaceSessionRules(session.allowRules, session.denyRules);
		sessionRuleErrors = session.errors;
		const config = await loadConfigs(ctx.cwd);
		const warnings = [...sessionRuleErrors, ...config.errors];
		if (ctx.hasUI) {
			if (warnings.length > 0) ctx.ui.notify(`tool-guard warnings:\n${warnings.join("\n")}`, "warning");
		}
	});

	pi.on("before_agent_start", async (event) => ({
		systemPrompt:
			event.systemPrompt +
			"\n\nPermission policy active: read/list/search tools are allowed; write/edit targets inside the current working directory are allowed; write/edit targets outside the current working directory require user confirmation; agent bash tool calls are parsed with tree-sitter-bash and each simple command is classified as harmless or potentially harmful. Bash allow/deny rules apply to each parsed sub-command, not the whole line. Fully harmless bash lines are allowed automatically unless a deny rule matches one of their parsed sub-commands. Potentially harmful sub-commands require approval unless they match a session, directory, repo, or global allow regex. Matching deny regexes override allows and block the bash tool call.",
	}));

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			const command = String((event.input as any).command ?? "");
			const config = await loadConfigs(ctx.cwd);
			return confirmBash(ctx, command, bashAllowRules, bashDenyRules, config, saveSessionRules);
		}

		if (!WRITING_TOOLS.has(event.toolName)) return undefined;

		const inputPath = (event.input as any).path;
		if (typeof inputPath !== "string") return undefined;

		const cwdReal = await realpathOrResolve(ctx.cwd);
		const absolutePath = resolve(ctx.cwd, stripAtPrefix(inputPath));
		const targetReal = await canonicalizeForPolicy(absolutePath);

		if (isInside(cwdReal, targetReal)) return undefined;

		return confirmFileMutation(ctx, event.toolName, inputPath, targetReal, cwdReal);
	});

}
