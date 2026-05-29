import { LEGACY_SESSION_RULES_ENTRY_TYPE, SESSION_RULES_ENTRY_TYPE } from "./constants.ts";
import type { BashRule, LoadedSessionRuleState, PermissionConfig } from "./types.ts";

function normalizeConfig(value: unknown): PermissionConfig {
	const config = value && typeof value === "object" && !Array.isArray(value) ? (value as PermissionConfig) : { version: 1, bash: {} };
	config.version ??= 1;
	config.bash = config.bash && typeof config.bash === "object" && !Array.isArray(config.bash) ? config.bash : {};
	config.bash.allow = Array.isArray(config.bash.allow) ? config.bash.allow : [];
	config.bash.deny = Array.isArray(config.bash.deny) ? config.bash.deny : [];
	if (Array.isArray(config.bashAllowRules) && config.bash.allow.length === 0) {
		config.bash.allow = config.bashAllowRules;
	}
	return config;
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
	if (latest === undefined) return { allowRules: [], denyRules: [], errors: [] };

	const config = normalizeConfig(latest);
	const allow = compileSessionRules(config.bash?.allow ?? [], "allow");
	const deny = compileSessionRules(config.bash?.deny ?? [], "deny");
	return { allowRules: allow.rules, denyRules: deny.rules, errors: [...allow.errors, ...deny.errors] };
}

export function persistedSessionRules(allowRules: BashRule[], denyRules: BashRule[]): PermissionConfig {
	return {
		version: 1,
		bash: {
			allow: allowRules.map((rule) => ({ source: rule.source })),
			deny: denyRules.map((rule) => ({ source: rule.source })),
		},
	};
}
