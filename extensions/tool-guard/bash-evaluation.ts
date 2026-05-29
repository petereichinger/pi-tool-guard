import { matchingBashRule } from "./rule-utils.ts";
import type { BashAnalysis, BashAnalysisEvaluation, BashRule, BashRuleDecision, LoadedConfigState } from "./types.ts";

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

export function evaluateBashAnalysis(
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
	const pendingDangerous = commands.filter(
		(item) => !item.harmless && !item.allowedOnce && item.ruleDecision?.type !== "allow" && item.ruleDecision?.type !== "deny",
	);
	return { commands, denied, pendingDangerous };
}
