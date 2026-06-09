import { LEGACY_SESSION_RULES_ENTRY_TYPE, SESSION_RULES_ENTRY_TYPE } from "./constants.ts";
import type { BashRule, LoadedSessionRuleState, PermissionConfig, StoredWriteDirectoryRule } from "./types.ts";

function normalizeConfig(value: unknown): PermissionConfig {
	const config = value && typeof value === "object" && !Array.isArray(value) ? (value as PermissionConfig) : { version: 1, bash: {} };
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

function storedWriteDirectoryPath(entry: StoredWriteDirectoryRule): string | undefined {
	if (typeof entry === "string") return entry;
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
	return typeof entry.path === "string" ? entry.path : undefined;
}

function compileWriteDirectories(entries: StoredWriteDirectoryRule[] | undefined): { directories: string[]; errors: string[] } {
	const directories: string[] = [];
	const errors: string[] = [];
	for (const [index, entry] of (entries ?? []).entries()) {
		const path = storedWriteDirectoryPath(entry);
		if (!path) {
			errors.push(`session tool-guard entry: ignored session write allow directory #${index + 1}: missing string path`);
			continue;
		}
		directories.push(path);
	}
	return { directories, errors };
}

function compileSessionRules(entries: unknown[], list: "allow" | "deny"): { rules: BashRule[]; errors: string[] } {
	const rules: BashRule[] = [];
	const errors: string[] = [];
	for (const [index, entry] of entries.entries()) {
		let source: string | undefined;
		let description: string | undefined;
		if (typeof entry === "string") source = entry;
		else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
			source = typeof (entry as any).source === "string" ? (entry as any).source : undefined;
			description = typeof (entry as any).description === "string" ? (entry as any).description : undefined;
		}
		if (!source) {
			errors.push(`session tool-guard entry: ignored session ${list} rule #${index + 1}: missing string source`);
			continue;
		}
		try {
			rules.push({ source, regex: new RegExp(source), scope: "session", list, description });
		} catch (error: any) {
			errors.push(`session tool-guard entry: ignored session ${list} rule #${index + 1} /${source}/: ${error.message}`);
		}
	}
	return { rules, errors };
}

export function loadSessionRules(ctx: any): LoadedSessionRuleState {
	const entries = ctx.sessionManager.getEntries();
	let latest: unknown;
	for (const entry of entries) {
		if (
			entry.type === "custom" &&
			(entry.customType === SESSION_RULES_ENTRY_TYPE || entry.customType === LEGACY_SESSION_RULES_ENTRY_TYPE)
		) latest = entry.data;
	}
	if (latest === undefined) return { allowRules: [], denyRules: [], writeAllowDirectories: [], errors: [] };

	const config = normalizeConfig(latest);
	const allow = compileSessionRules(config.bash?.allow ?? [], "allow");
	const deny = compileSessionRules(config.bash?.deny ?? [], "deny");
	const writeAllowDirectories = compileWriteDirectories(config.write?.allowDirectories);
	return {
		allowRules: allow.rules,
		denyRules: deny.rules,
		writeAllowDirectories: writeAllowDirectories.directories,
		errors: [...allow.errors, ...deny.errors, ...writeAllowDirectories.errors],
	};
}

export function persistedSessionRules(allowRules: BashRule[], denyRules: BashRule[], writeAllowDirectories: string[]): PermissionConfig {
	return {
		version: 1,
		bash: {
			allow: allowRules.map((rule) => ({ source: rule.source })),
			deny: denyRules.map((rule) => ({ source: rule.source })),
		},
		write: {
			allowDirectories: writeAllowDirectories.map((path) => ({ path })),
		},
	};
}
