import { resolve } from "node:path";
import { resolveCurrentGitTarget } from "./git-analysis.ts";
import { canonicalizeForPolicy, stripAtPrefix } from "./path-policy.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addPersistentGitTarget, canonicalizeGitTarget, addPersistentRule, clearPersistentRule, clearPersistentWriteDirectory, removePersistentGitTargets, loadConfigs } from "./config-store.ts";
import { addRule, exactRuleSource } from "./rule-utils.ts";
import type { BashRule, BashRuleList, BashRuleScope, GitTarget, PersistentBashRuleScope, WriteDirectoryRule } from "./types.ts";

type GuardCommandState = {
	bashAllowRules: BashRule[];
	bashDenyRules: BashRule[];
	writeAllowDirectories: string[];
	gitAllowTargets?: GitTarget[];
	gitDenyTargets?: GitTarget[];
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
	const { bashAllowRules, bashDenyRules, writeAllowDirectories, saveSessionRules, getSessionRuleErrors } = state;
	const gitAllowTargets = state.gitAllowTargets ?? [];
	const gitDenyTargets = state.gitDenyTargets ?? [];

	const addScopedRule = async (ctx: any, scope: BashRuleScope, list: BashRuleList, source: string) => {
		if (scope === "session") {
			const rules = list === "allow" ? bashAllowRules : bashDenyRules;
			addRule(source, rules, "session", list);
			saveSessionRules();
			ctx.ui.notify(`Added session shell ${list} rule #${rules.length}: /${source}/`, "info");
			return;
		}
		await addPersistentRule(ctx, scope, list, source);
		ctx.ui.notify(`Added ${scope} shell ${list} rule: /${source}/`, "info");
	};

	const registerRuleCommand = (name: string, list: BashRuleList, exact: boolean) => {
		pi.registerCommand(name, {
			description: `${list === "allow" ? "Allow" : "Deny"} ${exact ? "one exact" : "matching"} shell command${exact ? "" : "s"}. Usage: /${name} [session|directory|repo|global] <${exact ? "command" : "regex"}>`,
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

	pi.registerCommand("guard-deny-git", {
		description: "Deny a Git repository target. Usage: /guard-deny-git [session|directory|repo|global] [path]",
		handler: async (args, ctx) => {
			const { scope, value } = splitOptionalScope(args);
			try {
				const path = await canonicalizeForPolicy(resolve(ctx.cwd, stripAtPrefix(value || ".")));
				const resolved = await resolveCurrentGitTarget(path);
				if (!resolved) throw new Error(`No Git repository detected at ${path}`);
				const target = canonicalizeGitTarget(resolved);
				if (scope === "session") {
					if (!gitDenyTargets.some((entry) => entry.gitDir === target.gitDir && entry.workTree === target.workTree)) {
						gitDenyTargets.push(target);
					}
					saveSessionRules();
				} else await addPersistentGitTarget(ctx, scope, target, "deny");
				ctx.ui.notify(`Added ${scope} Git target deny: ${target.gitDir}${target.workTree ? `; worktree: ${target.workTree}` : "; bare repository"}`, "info");
			} catch (error: any) {
				ctx.ui.notify(`Could not deny ${scope} Git target: ${error.message}`, "error");
			}
		},
	});

	pi.registerCommand("guard-list", {
		description: "List shell rules, write-directory allows, and Git target allows and denies. Usage: /guard-list [all|session|directory|repo|global]",
		handler: async (args, ctx) => {
			const scope = args.trim() || "all";
			if (!["all", "session", "directory", "repo", "global"].includes(scope)) {
				ctx.ui.notify("Usage: /guard-list [all|session|directory|repo|global]", "warning");
				return;
			}

			const config = await loadConfigs(ctx);
			const sections: string[] = [];
			if (scope === "all" || scope === "session") {
				try {
					const currentTarget = await resolveCurrentGitTarget(ctx.cwd);
					if (currentTarget) {
						const denied = [...gitDenyTargets, ...(config.gitDenyTargets ?? [])].some(
							(target) => target.gitDir === currentTarget.gitDir && target.workTree === currentTarget.workTree,
						);
						sections.push(`Current working directory Git target (${denied ? "explicitly denied" : "automatically allowed"}):`);
						sections.push(`  Git directory: ${currentTarget.gitDir}${currentTarget.workTree ? `; worktree: ${currentTarget.workTree}` : "; bare repository"}`);
					}
				} catch (error: any) {
					sections.push(`Current working directory Git target unavailable: ${error.message}`);
				}
			}
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
			const addSessionWriteDirectorySection = () => {
				if (writeAllowDirectories.length === 0) return false;
				sections.push("Session write directories:");
				sections.push(...writeAllowDirectories.map((path, index) => `  ${index + 1}. ${path}`));
				return true;
			};
			const addPersistentWriteDirectorySection = (title: string, rules: WriteDirectoryRule[]) => {
				if (rules.length === 0) return false;
				sections.push(`${title} write directories:`);
				sections.push(...rules.map((rule, index) => `  ${index + 1}. ${rule.path}${rule.description ? ` — ${rule.description}` : ""}`));
				return true;
			};

			const addGitTargetSection = (title: string, targets: GitTarget[] = [], list: BashRuleList = "allow") => {
				if (targets.length === 0) return;
				sections.push(`${title} Git ${list} targets:`);
				sections.push(...targets.map((target, index) => `  ${index + 1}. Git directory: ${target.gitDir}${target.workTree ? `; worktree: ${target.workTree}` : "; bare repository"}`));
			};

			if (scope === "all" || scope === "session") {
				addScopedSections("Session", bashAllowRules, bashDenyRules);
				addSessionWriteDirectorySection();
				addGitTargetSection("Session", gitAllowTargets);
				addGitTargetSection("Session", gitDenyTargets, "deny");
			}
			if (scope === "all" || scope === "directory") {
				addScopedSections("Directory", config.directory.allowRules, config.directory.denyRules, config.directory.path);
				addPersistentWriteDirectorySection("Directory", config.directory.writeAllowDirectories);
				addGitTargetSection("Directory", config.directory.gitAllowTargets);
				addGitTargetSection("Directory", config.directory.gitDenyTargets, "deny");
			}
			if (scope === "all" || scope === "repo") {
				if (config.repo) {
					addScopedSections("Repo", config.repo.allowRules, config.repo.denyRules, config.repo.path);
					addPersistentWriteDirectorySection("Repo", config.repo.writeAllowDirectories);
					addGitTargetSection("Repo", config.repo.gitAllowTargets);
					addGitTargetSection("Repo", config.repo.gitDenyTargets, "deny");
				} else if (scope === "repo") sections.push("No Git repo detected for repo-scoped rules.");
			}
			if (scope === "all" || scope === "global") {
				addScopedSections("Global", config.global.allowRules, config.global.denyRules, config.global.path);
				addPersistentWriteDirectorySection("Global", config.global.writeAllowDirectories);
				addGitTargetSection("Global", config.global.gitAllowTargets);
				addGitTargetSection("Global", config.global.gitDenyTargets, "deny");
			}
			const warnings = [...getSessionRuleErrors(), ...config.errors];
			if (warnings.length > 0) sections.push("", "Warnings:", ...warnings.map((error) => `  ${error}`));

			ctx.ui.notify(sections.length === 0 ? "No guard rules." : sections.join("\n"), "info");
		},
	});

	pi.registerCommand("guard-clear", {
		description: "Clear shell rules, write-directory allows, or Git target allows and denies. Usage: /guard-clear [session|directory|repo|global] [all|allow|deny|write|git|git-deny|number] [all|number]",
		handler: async (args, ctx) => {
			const { scope, value } = splitOptionalScope(args);
			const parts = value.split(/\s+/).filter(Boolean);
			const clearSessionRules = (rules: BashRule[], list: BashRuleList, target: string | undefined) => {
				if (!target || target === "all") {
					rules.splice(0, rules.length);
					saveSessionRules();
					ctx.ui.notify(`Cleared session shell ${list} rules.`, "info");
					return;
				}
				const index = Number(target) - 1;
				if (!Number.isInteger(index) || index < 0 || index >= rules.length) {
					ctx.ui.notify("Usage: /guard-clear [session|directory|repo|global] [all|allow|deny|write|number] [all|number]", "warning");
					return;
				}
				const [removed] = rules.splice(index, 1);
				saveSessionRules();
				ctx.ui.notify(`Removed session ${list} rule: /${removed.source}/`, "info");
			};
			const clearSessionWriteDirectories = (target: string | undefined) => {
				if (!target || target === "all") {
					writeAllowDirectories.splice(0, writeAllowDirectories.length);
					saveSessionRules();
					ctx.ui.notify("Cleared session write-directory allows.", "info");
					return;
				}
				const index = Number(target) - 1;
				if (!Number.isInteger(index) || index < 0 || index >= writeAllowDirectories.length) {
					ctx.ui.notify("Usage: /guard-clear session write [all|number]", "warning");
					return;
				}
				const [removed] = writeAllowDirectories.splice(index, 1);
				saveSessionRules();
				ctx.ui.notify(`Removed session write-directory allow: ${removed}`, "info");
			};

			if (parts[0] === "git" || parts[0] === "git-deny") {
				const list: BashRuleList = parts[0] === "git-deny" ? "deny" : "allow";
				const targets = list === "deny" ? gitDenyTargets : gitAllowTargets;
				const target = parts[1] ?? "all";
				if (parts.length > 2 || (target !== "all" && !/^[1-9]\d*$/.test(target))) {
					ctx.ui.notify("Usage: /guard-clear [session|directory|repo|global] <git|git-deny> [all|number]", "warning");
					return;
				}
				try {
					if (scope === "session") {
						if (target === "all") targets.splice(0, targets.length);
						else {
							const index = Number(target) - 1;
							if (index >= targets.length) throw new Error(`No session Git ${list} target #${target}`);
							targets.splice(index, 1);
						}
						saveSessionRules();
					} else await removePersistentGitTargets(ctx, scope, target, list);
					ctx.ui.notify(`Cleared ${scope} Git ${list} target${target === "all" ? "s" : ` #${target}`}.`, "info");
				} catch (error: any) {
					ctx.ui.notify(`Could not clear ${scope} Git ${list} targets: ${error.message}`, "error");
				}
				return;
			}

			if (scope === "session") {
				if (parts.length === 0 || parts[0] === "all") {
					bashAllowRules.splice(0, bashAllowRules.length);
					bashDenyRules.splice(0, bashDenyRules.length);
					writeAllowDirectories.splice(0, writeAllowDirectories.length);
					gitAllowTargets.splice(0, gitAllowTargets.length);
					gitDenyTargets.splice(0, gitDenyTargets.length);
					saveSessionRules();
					ctx.ui.notify("Cleared all session guard rules.", "info");
					return;
				}
				if (parts[0] === "allow") return clearSessionRules(bashAllowRules, "allow", parts[1]);
				if (parts[0] === "deny") return clearSessionRules(bashDenyRules, "deny", parts[1]);
				if (parts[0] === "write") return clearSessionWriteDirectories(parts[1]);
				return clearSessionRules(bashAllowRules, "allow", parts[0]);
			}

			if (parts.length === 0 || (parts[0] === "all" && parts.length === 1)) {
				try {
					await clearPersistentRule(ctx, scope, "allow", "all");
					await clearPersistentRule(ctx, scope, "deny", "all");
					await clearPersistentWriteDirectory(ctx, scope, "all");
					await removePersistentGitTargets(ctx, scope, "all");
					await removePersistentGitTargets(ctx, scope, "all", "deny");
					ctx.ui.notify(`Cleared all ${scope} guard rules.`, "info");
				} catch (error: any) {
					ctx.ui.notify(`Could not clear ${scope} rules: ${error.message}`, "error");
				}
				return;
			}

			const [list, target] = parts;
			if ((list !== "allow" && list !== "deny" && list !== "write") || !target) {
				ctx.ui.notify("Usage: /guard-clear <directory|repo|global> <allow|deny|write> <all|number>", "warning");
				return;
			}
			try {
				const persistentScope = scope as PersistentBashRuleScope;
				if (list === "write") {
					await clearPersistentWriteDirectory(ctx, persistentScope, target);
					ctx.ui.notify(`Cleared ${scope} write rule${target === "all" ? "s" : ` #${target}`}.`, "info");
					return;
				}
				await clearPersistentRule(ctx, persistentScope, list as BashRuleList, target);
				ctx.ui.notify(`Cleared ${scope} ${list} rule${target === "all" ? "s" : ` #${target}`}.`, "info");
			} catch (error: any) {
				ctx.ui.notify(`Could not clear ${scope} rule: ${error.message}`, "error");
			}
		},
	});
}
