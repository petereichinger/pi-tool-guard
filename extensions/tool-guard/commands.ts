import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addPersistentRule, clearPersistentRule, loadConfigs } from "./config-store.ts";
import { addRule, exactRuleSource } from "./rule-utils.ts";
import type { BashRule, BashRuleList, BashRuleScope } from "./types.ts";

type GuardCommandState = {
	bashAllowRules: BashRule[];
	bashDenyRules: BashRule[];
	saveSessionRules: () => void;
	getSessionRuleErrors: () => string[];
};

function splitOptionalScope(raw: string): { scope: BashRuleScope; value: string } {
	const trimmed = raw.trim();
	const match = trimmed.match(/^(session|directory|repo|global)(?:\s+|$)/);
	if (!match) return { scope: "session", value: trimmed };
	return { scope: match[1] as BashRuleScope, value: trimmed.slice(match[0].length).trim() };
}

export function registerGuardCommands(pi: ExtensionAPI, state: GuardCommandState) {
	const { bashAllowRules, bashDenyRules, saveSessionRules, getSessionRuleErrors } = state;

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
			const warnings = [...getSessionRuleErrors(), ...config.errors];
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
}
