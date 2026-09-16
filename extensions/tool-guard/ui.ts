import { dirname, resolve } from "node:path";
import { notifyGuardPrompt } from "./desktop-notify.ts";
import { GuardSelectionDialog } from "./selection-dialog.ts";
import { canonicalizeForPolicy, isInside, stripAtPrefix } from "./path-policy.ts";
import { formatDisplayedBashCommand } from "./rule-utils.ts";
import type {
	BashAnalysis,
	BashAnalysisEvaluation,
	BashDialogDecision,
	BashRuleScope,
	FileMutationDecision,
	LoadedConfigState,
} from "./types.ts";

type DialogChoice<T> = {
	label: string;
	value: T;
};

function themed(ctx: any, color: string, text: string, bold = false): string {
	const theme = ctx.ui?.theme;
	if (!theme?.fg) return text;
	const content = bold && theme.bold ? theme.bold(text) : text;
	return theme.fg(color, content);
}

async function selectAction<T>(ctx: any, getTitle: () => string, choices: DialogChoice<T>[]): Promise<T | undefined> {
	const labels = choices.map((choice) => choice.label);
	let selected: string | undefined;
	if (ctx.mode === "tui" && ctx.ui.theme && ctx.ui.custom) {
		selected = await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: (value: string | undefined) => void) =>
			new GuardSelectionDialog(getTitle, labels, theme, done, () => done(undefined), () => tui.requestRender()),
		);
	} else {
		const displayed = labels.map((label) => themed(ctx, "accent", label));
		const displayedSelection = await ctx.ui.select(getTitle(), displayed);
		const selectedIndex = displayed.indexOf(displayedSelection ?? "");
		selected = selectedIndex >= 0 ? labels[selectedIndex] : displayedSelection;
	}
	return choices.find((choice) => choice.label === selected)?.value;
}

export async function editRegexRule(
	ctx: any,
	title: string,
	subCommand: string,
	initialValue: string,
): Promise<string | undefined> {
	const contextualTitle = `${title}\n\nCommand: ${subCommand}`;
	return ctx.ui.editor(contextualTitle, initialValue);
}

async function selectFileMutationDecisionDialog(
	ctx: any,
	targetReal: string,
	actionChoices: DialogChoice<FileMutationDecision>[],
	scopeChoices: BashRuleScope[],
): Promise<FileMutationDecision | undefined> {
	const actionChoice = await selectAction(
		ctx,
		() => `${themed(ctx, "warning", "Allow write?", true)}\n\n${themed(ctx, "mdCode", targetReal)}`,
		actionChoices,
	);
	if (!actionChoice || actionChoice.type !== "save") return actionChoice;

	const scope = await ctx.ui.select("Save write-directory allow rule scope", scopeChoices);
	if (!scope) return undefined;
	const modeChoice = await ctx.ui.select("Save write-directory allow rule mode", ["Folder of this file", "Custom path"]);
	if (!modeChoice) return undefined;
	return { type: "save", scope, mode: modeChoice === "Custom path" ? "custom" : "folder" };
}

export async function confirmFileMutation(
	ctx: any,
	_toolName: string,
	_requestedPath: string,
	targetReal: string,
	_cwdReal: string,
	config: LoadedConfigState,
	addAllowedDirectory: (scope: BashRuleScope, path: string) => Promise<void>,
) {
	if (!ctx.hasUI) return { block: true, reason: `Write/edit outside CWD blocked: ${targetReal}` } as const;

	const notification = notifyGuardPrompt(`Write permission needed:\n${targetReal}`);
	const actionChoices: DialogChoice<FileMutationDecision>[] = [
		{ label: "Allow once", value: { type: "allow-once" } },
		{ label: "Deny", value: { type: "block" } },
		{ label: "Add rule…", value: { type: "save", scope: "session", mode: "folder" } },
	];
	const scopeChoices: BashRuleScope[] = ["session", "directory", ...(config.repoLocation ? (["repo"] as const) : []), "global"];

	const decision = await selectFileMutationDecisionDialog(ctx, targetReal, actionChoices, scopeChoices)
		.finally(() => notification.dismiss());

	if (!decision || decision.type === "block") return { block: true, reason: "Blocked by user" } as const;
	if (decision.type === "allow-once") return undefined;

	let allowedPath = dirname(targetReal);
	if (decision.mode === "custom") {
		const input = await ctx.ui.input("Path to allow writes under", allowedPath);
		if (!input) return { block: true, reason: "Blocked by user" } as const;
		allowedPath = await canonicalizeForPolicy(resolve(ctx.cwd, stripAtPrefix(input)));
	}

	if (!isInside(allowedPath, targetReal)) {
		return {
			block: true,
			reason: `Allowed path does not include requested path. Allowed path: ${allowedPath}. Requested path: ${targetReal}`,
		} as const;
	}

	try {
		await addAllowedDirectory(decision.scope, allowedPath);
		ctx.ui.notify(`Allowed writes under ${allowedPath} in ${decision.scope} scope.`, "info");
		return undefined;
	} catch (error: any) {
		ctx.ui.notify(`Could not save ${decision.scope} write rule: ${error.message}`, "error");
		return { block: true, reason: `Could not save ${decision.scope} write rule: ${error.message}` } as const;
	}
}

export async function selectBashDecision(
	ctx: any,
	evaluation: BashAnalysisEvaluation,
	analysis: BashAnalysis,
	targetIndex: number,
	config: LoadedConfigState,
	initialStage: "action" | "save" = "action",
	shellLabel = "Bash",
): Promise<BashDialogDecision | undefined> {
	const actionChoices: DialogChoice<BashDialogDecision>[] = [
		{ label: "Allow once", value: { type: "allow-once" } },
		{ label: "Deny", value: { type: "block" } },
		{ label: "Save allow rule…", value: { type: "save", scope: "session", mode: "exact" } },
	];
	const scopeChoices: BashRuleScope[] = ["session", "directory", ...(config.repoLocation ? (["repo"] as const) : []), "global"];
	const promptedCommand = evaluation.commands.find((item) => item.index === targetIndex);
	const notification = notifyGuardPrompt(`${shellLabel} permission needed:\n${promptedCommand ? formatDisplayedBashCommand(promptedCommand) : "dangerous command"}`);

	try {
		return await selectBashDecisionDialog(ctx, evaluation, analysis, targetIndex, actionChoices, scopeChoices, initialStage, shellLabel);
	} finally {
		notification.dismiss();
	}
}

async function selectBashDecisionDialog(
	ctx: any,
	evaluation: BashAnalysisEvaluation,
	analysis: BashAnalysis,
	targetIndex: number,
	actionChoices: DialogChoice<BashDialogDecision>[],
	scopeChoices: BashRuleScope[],
	initialStage: "action" | "save",
	shellLabel: string,
): Promise<BashDialogDecision | undefined> {
	const shellName = shellLabel.toLowerCase();
	const getTitle = () => {
		const commandLines = evaluation.commands.length === 0
			? [themed(ctx, "muted", " No executable commands detected")]
			: evaluation.commands.map((item) => {
				const approved = item.harmless || item.allowedOnce || item.ruleDecision?.type === "allow";
				const active = item.index === targetIndex;
				const marker = active ? (approved ? "→ " : "→ 󰹆") : approved ? "  " : "  󰹆";
				const stateColor = approved ? "success" : active ? "warning" : "muted";
				return `${themed(ctx, stateColor, marker)} ${themed(ctx, "mdCode", formatDisplayedBashCommand(item), active)}`;
			});
		const parserLines = analysis.parserAvailable || !analysis.error
			? []
			: [themed(ctx, "error", `Parser error: ${analysis.error}`)];
		const heading = initialStage === "save"
			? `Save allow rule for ${shellName} command`
			: `Allow ${shellName} command?`;
		return [
			themed(ctx, initialStage === "save" ? "accent" : "warning", heading, true),
			"",
			...commandLines,
			...parserLines,
		].join("\n");
	};

	let action: BashDialogDecision | undefined;
	if (initialStage === "save") {
		action = { type: "save", scope: "session", mode: "exact" };
	} else {
		action = await selectAction(ctx, getTitle, actionChoices);
	}

	if (!action || action.type === "block") return { type: "block" };
	if (action.type === "allow-once") return { type: "allow-once" };

	const targetCommand = evaluation.commands.find((item) => item.index === targetIndex);
	const commandContext = targetCommand ? formatDisplayedBashCommand(targetCommand) : "dangerous command";
	const scope = await ctx.ui.select(`Save ${shellName} allow rule scope\n\nCommand: ${commandContext}`, scopeChoices);
	if (!scope) return undefined;

	const modeChoice = await ctx.ui.select(`Save ${shellName} allow rule mode\n\nCommand: ${commandContext}`, ["Exact command", "Regex rule"]);
	if (!modeChoice) return undefined;

	return {
		type: "save",
		scope,
		mode: modeChoice === "Regex rule" ? "regex" : "exact",
	};
}
