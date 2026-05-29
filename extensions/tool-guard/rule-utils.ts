import type { BashCommandRisk, BashRule, BashRuleList, BashRuleScope } from "./types.ts";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function exactRuleSource(command: string): string {
	return `^${escapeRegExp(command)}$`;
}

export function addRule(source: string, rules: BashRule[], scope: BashRuleScope, list: BashRuleList): BashRule {
	const rule = { source, regex: new RegExp(source), scope, list };
	rules.push(rule);
	return rule;
}

export function addExactRule(command: string, rules: BashRule[], scope: BashRuleScope, list: BashRuleList): BashRule {
	return addRule(exactRuleSource(command), rules, scope, list);
}

export function matchingBashRule(command: string, rules: BashRule[]): BashRule | undefined {
	return rules.find((rule) => {
		rule.regex.lastIndex = 0;
		return rule.regex.test(command);
	});
}

export function ruleLabel(rule: BashRule): string {
	return `${rule.scope} ${rule.list} rule /${rule.source}/`;
}

export function formatDisplayedBashCommand(command: Pick<BashCommandRisk, "command" | "splitter">): string {
	return `${command.splitter ? `${command.splitter} ` : ""}${command.command}`;
}
