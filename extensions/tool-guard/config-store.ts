import { createScopedJsonStore, resolveScopedConfigLocations } from "pi-scoped-config";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { canonicalizeForPolicy, stripAtPrefix } from "./path-policy.ts";
import type {
	BashRule,
	BashRuleList,
	BashRuleScope,
	GitTarget,
	LoadedConfigFile,
	LoadedConfigState,
	PermissionConfig,
	PersistentBashRuleScope,
	RepoConfigLocation,
	StoredBashRule,
	StoredWriteDirectoryRule,
	WriteDirectoryRule,
} from "./types.ts";

function defaultConfig(): PermissionConfig {
	return { version: 1, bash: { allow: [], deny: [] }, write: { allowDirectories: [] }, git: { allowTargets: [], denyTargets: [] } };
}

export function canonicalizeGitTarget(value: unknown): GitTarget {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a Git target object");
	const target = value as GitTarget;
	const canonicalize = (path: unknown): string => {
		if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
			throw new Error("Git target paths must be absolute strings without NUL characters");
		}
		let current = resolve(path);
		const missing: string[] = [];
		while (true) {
			try {
				return resolve(realpathSync(current), ...missing);
			} catch (error: any) {
				if (error.code !== "ENOENT") throw error;
				const parent = dirname(current);
				if (parent === current) throw error;
				missing.unshift(basename(current));
				current = parent;
			}
		}
	};
	return {
		gitDir: canonicalize(target.gitDir),
		...(target.workTree === undefined ? {} : { workTree: canonicalize(target.workTree) }),
	};
}

export function compileStoredGitTargets(entries: unknown, label: string, list: BashRuleList = "allow"): { targets: GitTarget[]; errors: string[] } {
	const targets: GitTarget[] = [];
	const errors: string[] = [];
	if (entries === undefined) return { targets, errors };
	if (!Array.isArray(entries)) return { targets, errors: [`${label}: Git ${list}Targets must be an array`] };
	for (const [index, entry] of entries.entries()) {
		try {
			targets.push(canonicalizeGitTarget(entry));
		} catch (error: any) {
			errors.push(`${label}: ignored Git target #${index + 1}: ${error.message}`);
		}
	}
	return { targets, errors };
}

function normalizeConfig(value: unknown): PermissionConfig {
	const config = value && typeof value === "object" && !Array.isArray(value) ? (value as PermissionConfig) : defaultConfig();
	config.version ??= 1;
	config.bash = config.bash && typeof config.bash === "object" && !Array.isArray(config.bash) ? config.bash : {};
	config.bash.allow = Array.isArray(config.bash.allow) ? config.bash.allow : [];
	config.bash.deny = Array.isArray(config.bash.deny) ? config.bash.deny : [];
	config.write = config.write && typeof config.write === "object" && !Array.isArray(config.write) ? config.write : {};
	config.write.allowDirectories = Array.isArray(config.write.allowDirectories) ? config.write.allowDirectories : [];
	if (Array.isArray(config.bashAllowRules) && config.bash.allow.length === 0) {
		config.bash.allow = config.bashAllowRules;
	}
	return config;
}

const configStore = createScopedJsonStore<PermissionConfig>({
	name: "tool-guard",
	legacyNames: ["simple-permissions"],
	indent: "\t",
	decode(value) {
		return { value: normalizeConfig(value) };
	},
});

function projectIsTrusted(ctx: any): boolean {
	return typeof ctx?.isProjectTrusted === "function" && ctx.isProjectTrusted();
}

function storedRuleSource(entry: StoredBashRule): { source?: string; description?: string } {
	if (typeof entry === "string") return { source: entry };
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {};
	return {
		source: typeof entry.source === "string" ? entry.source : undefined,
		description: typeof entry.description === "string" ? entry.description : undefined,
	};
}

function storedWriteDirectoryPath(entry: StoredWriteDirectoryRule): { path?: string; description?: string } {
	if (typeof entry === "string") return { path: entry };
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {};
	return {
		path: typeof entry.path === "string" ? entry.path : undefined,
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

async function compileStoredWriteDirectories(
	entries: StoredWriteDirectoryRule[] | undefined,
	scope: PersistentBashRuleScope,
	path: string,
): Promise<{ rules: WriteDirectoryRule[]; errors: string[] }> {
	const rules: WriteDirectoryRule[] = [];
	const errors: string[] = [];
	for (const [index, entry] of (entries ?? []).entries()) {
		const { path: sourcePath, description } = storedWriteDirectoryPath(entry);
		if (!sourcePath) {
			errors.push(`${path}: ignored ${scope} write allow directory #${index + 1}: missing string path`);
			continue;
		}
		try {
			const absolutePath = resolve(dirname(path), stripAtPrefix(sourcePath));
			rules.push({ path: await canonicalizeForPolicy(absolutePath), scope, description });
		} catch (error: any) {
			errors.push(`${path}: ignored ${scope} write allow directory #${index + 1} ${sourcePath}: ${error.message}`);
		}
	}
	return { rules, errors };
}

async function compileConfigFile(
	file: {
		writePath: string;
		sourcePath?: string;
		value?: unknown;
		warnings: readonly string[];
		errors: readonly string[];
	},
	scope: PersistentBashRuleScope,
): Promise<LoadedConfigFile> {
	const path = file.sourcePath ?? file.writePath;
	const config = structuredClone(file.value ?? defaultConfig()) as PermissionConfig;
	const allow = compileStoredRules(config.bash?.allow, scope, "allow", path);
	const deny = compileStoredRules(config.bash?.deny, scope, "deny", path);
	const writeAllowDirectories = await compileStoredWriteDirectories(config.write?.allowDirectories, scope, path);
	const git = compileStoredGitTargets(config.git?.allowTargets, `${path}: ${scope}`);
	const gitDeny = compileStoredGitTargets(config.git?.denyTargets, `${path}: ${scope}`, "deny");
	return {
		path,
		scope,
		config,
		allowRules: allow.rules,
		denyRules: deny.rules,
		writeAllowDirectories: writeAllowDirectories.rules,
		gitAllowTargets: git.targets,
		gitDenyTargets: gitDeny.targets,
		errors: [
			...file.warnings,
			...file.errors,
			...allow.errors,
			...deny.errors,
			...writeAllowDirectories.errors,
			...git.errors,
			...gitDeny.errors,
		],
	};
}

export async function loadConfigs(ctx: any): Promise<LoadedConfigState> {
	const trusted = projectIsTrusted(ctx);
	const scoped = await configStore.load({ cwd: ctx.cwd, projectTrusted: trusted });
	const globalConfig = await compileConfigFile(scoped.global, "global");

	let directoryConfig: LoadedConfigFile;
	if (scoped.directory) {
		directoryConfig = await compileConfigFile(scoped.directory, "directory");
	} else {
		const locations = await resolveScopedConfigLocations({
			cwd: ctx.cwd,
			name: "tool-guard",
			discoverRepository: false,
		});
		directoryConfig = await compileConfigFile(
			{ writePath: locations.directory.writePath, warnings: [], errors: [] },
			"directory",
		);
	}

	const repoConfig = scoped.repo ? await compileConfigFile(scoped.repo, "repo") : undefined;
	const repoLocation: RepoConfigLocation | undefined =
		trusted && scoped.repository && scoped.repo
			? {
				repoRoot: scoped.repository.root,
				commonDir: scoped.repository.commonDir,
				configPath: scoped.repo.writePath,
			}
			: undefined;

	return {
		cwd: scoped.cwd,
		global: globalConfig,
		directory: directoryConfig,
		repo: repoConfig,
		repoLocation,
		allowRules: [...directoryConfig.allowRules, ...(repoConfig?.allowRules ?? []), ...globalConfig.allowRules],
		denyRules: [...directoryConfig.denyRules, ...(repoConfig?.denyRules ?? []), ...globalConfig.denyRules],
		writeAllowDirectories: [
			...directoryConfig.writeAllowDirectories,
			...(repoConfig?.writeAllowDirectories ?? []),
			...globalConfig.writeAllowDirectories,
		],
		gitAllowTargets: [
			...(directoryConfig.gitAllowTargets ?? []),
			...(repoConfig?.gitAllowTargets ?? []),
			...(globalConfig.gitAllowTargets ?? []),
		],
		gitDenyTargets: [
			...(directoryConfig.gitDenyTargets ?? []),
			...(repoConfig?.gitDenyTargets ?? []),
			...(globalConfig.gitDenyTargets ?? []),
		],
		errors: [
			...new Set([
				...scoped.errors,
				...scoped.warnings,
				...directoryConfig.errors,
				...(repoConfig?.errors ?? []),
				...globalConfig.errors,
			]),
		],
	};
}

export function invalidateConfigCache() {
	configStore.invalidate();
}

async function loadWritableConfig(
	ctx: any,
	scope: PersistentBashRuleScope,
): Promise<{ path: string; config: PermissionConfig }> {
	const trusted = projectIsTrusted(ctx);
	if (scope !== "global" && !trusted) {
		throw new Error(`Cannot write ${scope} config for an untrusted project`);
	}

	const scoped = await configStore.load({ cwd: ctx.cwd, projectTrusted: trusted });
	const file = scope === "global" ? scoped.global : scope === "directory" ? scoped.directory : scoped.repo;
	if (!file) {
		if (scope === "repo") throw new Error("Not inside a Git repository; repo scope is unavailable");
		throw new Error(`${scope} config is unavailable`);
	}
	return {
		path: file.writePath,
		config: structuredClone(file.value ?? defaultConfig()) as PermissionConfig,
	};
}

async function saveConfigFile(path: string, config: PermissionConfig) {
	await configStore.write(path, config);
}

export async function addPersistentRule(ctx: any, scope: PersistentBashRuleScope, list: BashRuleList, source: string) {
	new RegExp(source);
	const file = await loadWritableConfig(ctx, scope);
	file.config.bash ??= { allow: [], deny: [] };
	file.config.bash.allow ??= [];
	file.config.bash.deny ??= [];
	file.config.bash[list]!.push({ source });
	await saveConfigFile(file.path, file.config);
}

export async function addPersistentWriteDirectory(ctx: any, scope: PersistentBashRuleScope, directory: string) {
	const file = await loadWritableConfig(ctx, scope);
	file.config.write ??= { allowDirectories: [] };
	file.config.write.allowDirectories ??= [];
	file.config.write.allowDirectories.push({ path: directory });
	await saveConfigFile(file.path, file.config);
}

export async function addPersistentGitTarget(ctx: any, scope: PersistentBashRuleScope, target: GitTarget, list: BashRuleList = "allow") {
	const canonical = canonicalizeGitTarget(target);
	const file = await loadWritableConfig(ctx, scope);
	file.config.git = file.config.git && typeof file.config.git === "object" && !Array.isArray(file.config.git) ? file.config.git : {};
	const key = list === "allow" ? "allowTargets" : "denyTargets";
	file.config.git[key] ??= [];
	const compiled = compileStoredGitTargets(file.config.git[key], file.path, list);
	if (compiled.errors.length > 0) throw new Error(compiled.errors.join("\n"));
	file.config.git[key] = compiled.targets;
	if (!compiled.targets.some((entry) => entry.gitDir === canonical.gitDir && entry.workTree === canonical.workTree)) {
		file.config.git[key].push(canonical);
	}
	await saveConfigFile(file.path, file.config);
}

export async function removePersistentGitTargets(ctx: any, scope: PersistentBashRuleScope, target: string, list: BashRuleList = "allow") {
	const file = await loadWritableConfig(ctx, scope);
	file.config.git = file.config.git && typeof file.config.git === "object" && !Array.isArray(file.config.git) ? file.config.git : {};
	const key = list === "allow" ? "allowTargets" : "denyTargets";
	const entries = file.config.git[key];
	if (target === "all") {
		file.config.git[key] = [];
	} else {
		const index = Number(target) - 1;
		const compiled = compileStoredGitTargets(entries, file.path, list);
		if (compiled.errors.length > 0) throw new Error(`${compiled.errors.join("\n")}\nClear all Git targets to remove invalid entries.`);
		if (!Number.isInteger(index) || index < 0 || index >= compiled.targets.length) throw new Error(`No ${scope} Git target #${target}`);
		compiled.targets.splice(index, 1);
		file.config.git[key] = compiled.targets;
	}
	await saveConfigFile(file.path, file.config);
}

export async function clearPersistentRule(ctx: any, scope: PersistentBashRuleScope, list: BashRuleList, target: string) {
	const file = await loadWritableConfig(ctx, scope);
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
	await saveConfigFile(file.path, file.config);
}

export async function clearPersistentWriteDirectory(ctx: any, scope: PersistentBashRuleScope, target: string) {
	const file = await loadWritableConfig(ctx, scope);
	file.config.write ??= { allowDirectories: [] };
	file.config.write.allowDirectories ??= [];
	const rules = file.config.write.allowDirectories;
	if (target === "all") {
		rules.splice(0, rules.length);
	} else {
		const index = Number(target) - 1;
		if (!Number.isInteger(index) || index < 0 || index >= rules.length) {
			throw new Error(`No ${scope} write rule #${target}`);
		}
		rules.splice(index, 1);
	}
	await saveConfigFile(file.path, file.config);
}
