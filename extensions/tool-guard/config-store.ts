import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { realpathOrResolve } from "./path-policy.ts";
import type {
	BashRule,
	BashRuleList,
	BashRuleScope,
	LoadedConfigFile,
	LoadedConfigState,
	PermissionConfig,
	PersistentBashRuleScope,
	RepoConfigLocation,
	StoredBashRule,
} from "./types.ts";

let configCache: LoadedConfigState | undefined;
let configLoadPromise: { cwd: string; promise: Promise<LoadedConfigState> } | undefined;

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

export async function loadConfigs(cwd: string): Promise<LoadedConfigState> {
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

export function invalidateConfigCache() {
	configCache = undefined;
	configLoadPromise = undefined;
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

export async function addPersistentRule(ctx: any, scope: PersistentBashRuleScope, list: BashRuleList, source: string) {
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

export async function clearPersistentRule(ctx: any, scope: PersistentBashRuleScope, list: BashRuleList, target: string) {
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
