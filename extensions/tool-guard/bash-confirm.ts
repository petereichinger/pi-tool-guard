import { addPersistentRule, loadConfigs } from "./config-store.ts";
import { analyzeBash, formatBashAnalysis } from "./bash-analysis.ts";
import { evaluateBashAnalysis } from "./bash-evaluation.ts";
import { addExactRule, exactRuleSource, formatDisplayedBashCommand, ruleLabel } from "./rule-utils.ts";
import { editRegexRule, selectBashDecision } from "./ui.ts";
import type { BashRule, LoadedConfigState } from "./types.ts";

export async function confirmBash(
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

		const source = (await editRegexRule(ctx, "Bash allow regex for sub-command", target.command, exactRuleSource(target.command)))?.trim();
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
