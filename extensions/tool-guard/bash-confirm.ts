import { addPersistentRule, loadConfigs } from "./config-store.ts";
import { analyzeBash, formatBashAnalysis } from "./bash-analysis.ts";
import { evaluateBashAnalysis } from "./bash-evaluation.ts";
import { analyzePowerShell } from "./powershell-analysis.ts";
import { addExactRule, exactRuleSource, formatDisplayedBashCommand, ruleLabel } from "./rule-utils.ts";
import type { HerdrInputStatusReporter } from "./herdr-status.ts";
import type { PermissionRequestRunner } from "./permission-queue.ts";
import { editRegexRule, selectBashDecision } from "./ui.ts";
import type { BashRule, LoadedConfigState } from "./types.ts";

const runImmediately: PermissionRequestRunner = (request) => request();

export async function confirmShell(
	ctx: any,
	shell: "bash" | "powershell",
	command: string,
	bashAllowRules: BashRule[],
	bashDenyRules: BashRule[],
	config: LoadedConfigState,
	onSessionRulesChanged: () => void = () => {},
	reportHerdrInputStatus?: HerdrInputStatusReporter,
	runPermissionRequest: PermissionRequestRunner = runImmediately,
	reloadConfig?: () => Promise<LoadedConfigState>,
) {
	let activeConfig = config;
	const shellLabel = shell === "powershell" ? "PowerShell" : "Bash";
	const analysis = shell === "powershell" ? analyzePowerShell(command) : await analyzeBash(command, ctx.cwd);
	const allHarmless = analysis.commands.every((item) => item.harmless);
	if (allHarmless) {
		const harmlessEvaluation = evaluateBashAnalysis(analysis, new Set<number>(), bashAllowRules, bashDenyRules, activeConfig);
		if (harmlessEvaluation.denied) {
			return {
				block: true,
				reason: `${shellLabel} command denied by ${ruleLabel(harmlessEvaluation.denied.ruleDecision!.rule)}: ${formatDisplayedBashCommand(harmlessEvaluation.denied)}`,
			} as const;
		}
		if (ctx.hasUI) ctx.ui.notify(`Allowed harmless ${shellLabel} command:\n${formatBashAnalysis(analysis)}`, "info");
		return undefined;
	}

	return runPermissionRequest(async () => {
		// This request may have waited behind another agent's prompt. Reload
		// persistent rules before evaluating it so newly saved rules take effect.
		if (reloadConfig) activeConfig = await reloadConfig();

		const allowedOnceIndexes = new Set<number>();
		let promptStage: "action" | "save" = "action";
		while (true) {
			const evaluation = evaluateBashAnalysis(analysis, allowedOnceIndexes, bashAllowRules, bashDenyRules, activeConfig);
		if (evaluation.denied) {
			return {
				block: true,
				reason: `${shellLabel} command denied by ${ruleLabel(evaluation.denied.ruleDecision!.rule)}: ${formatDisplayedBashCommand(evaluation.denied)}`,
			} as const;
		}
		if (evaluation.pendingDangerous.length === 0) return undefined;

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `${shellLabel} command blocked because no UI is available to approve potentially harmful commands.\n${formatBashAnalysis(analysis)}`,
			} as const;
		}

		const target = evaluation.pendingDangerous[0]!;
		const decision = await selectBashDecision(
			ctx,
			evaluation,
			analysis,
			target.index,
			activeConfig,
			promptStage,
			reportHerdrInputStatus,
			shellLabel,
		);
		promptStage = "action";
		if (!decision || decision.type === "block") return { block: true, reason: "Blocked by user" } as const;
		if (decision.type === "allow-once") return undefined;

		if (decision.mode === "exact") {
			if (decision.scope === "session") {
				addExactRule(target.command, bashAllowRules, "session", "allow");
				onSessionRulesChanged();
				ctx.ui.notify(`Added exact ${shellLabel} allow rule for this command in this session.`, "info");
				promptStage = "save";
				continue;
			}

			try {
				await addPersistentRule(ctx, decision.scope, "allow", exactRuleSource(target.command));
				activeConfig = await loadConfigs(ctx);
				ctx.ui.notify(`Added exact ${shellLabel} allow rule for this command in ${decision.scope} scope.`, "info");
				promptStage = "save";
				continue;
			} catch (error: any) {
				ctx.ui.notify(`Could not save ${decision.scope} rule: ${error.message}`, "error");
				return { block: true, reason: `Could not save ${decision.scope} rule: ${error.message}` } as const;
			}
		}

		const source = (await editRegexRule(
			ctx,
			`${shellLabel} allow regex for command`,
			target.command,
			exactRuleSource(target.command),
			reportHerdrInputStatus,
		))?.trim();
		if (!source) return { block: true, reason: "Blocked by user" } as const;

		try {
			const regex = new RegExp(source);
			if (decision.scope === "session") {
				bashAllowRules.push({ source, regex, scope: "session", list: "allow" });
				onSessionRulesChanged();
				ctx.ui.notify(`Added session ${shellLabel} allow rule for commands: /${source}/`, "info");
			} else {
				await addPersistentRule(ctx, decision.scope, "allow", source);
				activeConfig = await loadConfigs(ctx);
				ctx.ui.notify(`Added ${decision.scope} ${shellLabel} allow rule for commands: /${source}/`, "info");
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
	});
}
