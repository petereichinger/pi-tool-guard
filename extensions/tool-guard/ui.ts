import { formatDisplayedBashCommand } from "./rule-utils.ts";
import type {
	BashAnalysis,
	BashAnalysisEvaluation,
	BashDialogDecision,
	BashRuleScope,
	BashSaveMode,
	EvaluatedBashCommand,
	LoadedConfigState,
} from "./types.ts";

export async function confirmFileMutation(
	ctx: any,
	toolName: string,
	requestedPath: string,
	targetReal: string,
	cwdReal: string,
) {
	if (!ctx.hasUI) return { block: true, reason: `Write/edit outside CWD blocked: ${targetReal}` } as const;

	const ok = await ctx.ui.confirm(
		"Allow write outside CWD?",
		`Tool: ${toolName}\nRequested path: ${requestedPath}\nResolved path: ${targetReal}\nCWD: ${cwdReal}\n\nAllow this file mutation?`,
	);

	return ok ? undefined : ({ block: true, reason: "Blocked by user" } as const);
}

export async function selectBashDecision(
	ctx: any,
	evaluation: BashAnalysisEvaluation,
	analysis: BashAnalysis,
	targetIndex: number,
	config: LoadedConfigState,
	initialStage: "action" | "save" = "action",
): Promise<BashDialogDecision | undefined> {
	const actionChoices = ["Allow once", "Deny", "Save allow rule…"];
	const scopeChoices: BashRuleScope[] = ["session", "directory", ...(config.repoLocation ? (["repo"] as const) : []), "global"];

	return ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: (value: BashDialogDecision | undefined) => void) => {
		let stage: "action" | "save" = initialStage;
		let actionSelected = 0;
		let scopeSelected = 0;
		let saveMode: BashSaveMode = "exact";
		const ansiPattern = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[PX^_].*?\x1b\\|.)/;
		const charWidth = (char: string) => {
			const code = char.codePointAt(0) ?? 0;
			if ((code >= 0x300 && code <= 0x36f) || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
			if (
				(code >= 0x1100 && code <= 0x115f) ||
				(code >= 0x2329 && code <= 0x232a) ||
				(code >= 0x2600 && code <= 0x27bf) ||
				(code >= 0x2e80 && code <= 0xa4cf) ||
				(code >= 0xac00 && code <= 0xd7a3) ||
				(code >= 0xf900 && code <= 0xfaff) ||
				(code >= 0xfe10 && code <= 0xfe19) ||
				(code >= 0xfe30 && code <= 0xfe6f) ||
				(code >= 0xff00 && code <= 0xff60) ||
				(code >= 0xffe0 && code <= 0xffe6) ||
				(code >= 0x1f300 && code <= 0x1faff)
			) return 2;
			return 1;
		};
		const visibleWidth = (value: string) => {
			let width = 0;
			for (let index = 0; index < value.length;) {
				const ansi = value.slice(index).match(ansiPattern);
				if (ansi) {
					index += ansi[0].length;
					continue;
				}
				const char = Array.from(value.slice(index))[0] ?? "";
				width += charWidth(char);
				index += char.length;
			}
			return width;
		};
		const pad = (value: string, width: number) => `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
		const wrapPlain = (value: string, width: number) => {
			const wrapped: string[] = [];
			for (const sourceLine of value.split(/\r?\n/)) {
				if (sourceLine.length === 0) {
					wrapped.push("");
					continue;
				}

				let current = "";
				let used = 0;
				for (let index = 0; index < sourceLine.length;) {
					const char = Array.from(sourceLine.slice(index))[0] ?? "";
					const nextWidth = charWidth(char);
					if (current.length > 0 && used + nextWidth > width) {
						wrapped.push(current);
						current = "";
						used = 0;
						continue;
					}
					current += char;
					used += nextWidth;
					index += char.length;
					if (used >= width) {
						wrapped.push(current);
						current = "";
						used = 0;
					}
				}
				if (current.length > 0) wrapped.push(current);
			}
			return wrapped.length > 0 ? wrapped : [""];
		};
		const wrapPrefixed = (prefix: string, content: string, width: number, style: (value: string) => string = (value) => value) => {
			const prefixWidth = visibleWidth(prefix);
			const continuationPrefix = " ".repeat(prefixWidth);
			const contentWidth = Math.max(1, width - prefixWidth);
			const wrappedContent = wrapPlain(content, contentWidth);
			return wrappedContent.map((line, index) => `${index === 0 ? prefix : continuationPrefix}${style(line)}`);
		};
		const linesForCommand = (item: EvaluatedBashCommand, width: number) => {
			const active = stage === "save" && item.index === targetIndex;
			const approved = item.harmless || item.allowedOnce || item.ruleDecision?.type === "allow";
			const text = formatDisplayedBashCommand(item);
			const prefix = active ? (approved ? "→ ✅ " : "→ ⚠️ ") : approved ? "✅ " : "⚠️ ";
			if (approved) {
				return wrapPrefixed(prefix, text, width, (value) => (active ? theme.fg("accent", value) : value));
			}
			return wrapPrefixed(prefix, text, width, (value) => (active ? theme.fg("warning", theme.bold(value)) : theme.fg("warning", value)));
		};
		const scopeLabel = (scope: BashRuleScope) => `${scope[0]!.toUpperCase()}${scope.slice(1)}`;
		const modeLabel = (mode: BashSaveMode, label: string) => {
			const active = saveMode === mode;
			const prefix = active ? "◉ " : "○ ";
			const text = `${prefix}${label}`;
			return active ? theme.fg("accent", text) : theme.fg("muted", text);
		};
		const wrapInlineChoices = (choices: string[], selectedIndex: number, width: number) => {
			const lines: string[] = [];
			let current = "";
			let currentWidth = 0;
			for (const [index, choice] of choices.entries()) {
				const plain = index === selectedIndex ? `[${choice}]` : choice;
				const rendered = index === selectedIndex ? theme.fg("accent", theme.bold(plain)) : theme.fg("muted", plain);
				const separator = current.length === 0 ? "" : "  ";
				const nextWidth = currentWidth + (separator ? visibleWidth(separator) : 0) + visibleWidth(plain);
				if (current.length > 0 && nextWidth > width) {
					lines.push(current);
					current = rendered;
					currentWidth = visibleWidth(plain);
					continue;
				}
				current += `${separator}${rendered}`;
				currentWidth = nextWidth;
			}
			if (current.length > 0) lines.push(current);
			return lines;
		};

		return {
			render: (width: number) => {
				const boxWidth = Math.max(24, width - 12);
				const innerWidth = Math.max(1, boxWidth - 4);
				const border = (left: string, fill: string, right: string) => theme.fg("borderAccent", `${left}${fill.repeat(innerWidth + 2)}${right}`);
				const divider = theme.fg("borderAccent", "─".repeat(innerWidth));
				const boxed = (line: string) => theme.fg("borderAccent", "│ ") + pad(line, innerWidth) + theme.fg("borderAccent", " │");
				const stageLines =
					stage === "action"
						? [
							...wrapInlineChoices(actionChoices, actionSelected, innerWidth),
							...wrapPrefixed("", "Allow once approves the whole bash command.", innerWidth, (value) => theme.fg("dim", value)),
							"",
							...wrapPrefixed("", "←→ or ↑↓ navigate   enter select   escape/ctrl+c cancel", innerWidth, (value) => theme.fg("dim", value)),
						]
						: [
							theme.fg("accent", theme.bold("Save allow rule")),
							...wrapPrefixed("", "Applies to the highlighted sub-command. Tab or ←→ switches exact/regex. ↑↓ chooses scope.", innerWidth, (value) => theme.fg("dim", value)),
							"",
							theme.fg("accent", "Mode:"),
							`  ${modeLabel("exact", "Exact command")}`,
							`  ${modeLabel("regex", "Regex rule")}`,
							"",
							theme.fg("accent", "Scope:"),
							...scopeChoices.flatMap((scope, index) =>
								wrapPrefixed(
									`${index === scopeSelected ? "→" : " "} `,
									scopeLabel(scope),
									innerWidth,
									(value) => (index === scopeSelected ? theme.fg("accent", value) : value),
								),
							),
							"",
							...wrapPrefixed("", "enter save   escape back   ctrl+c cancel", innerWidth, (value) => theme.fg("dim", value)),
						];
				const lines = [
					theme.fg("accent", theme.bold(stage === "action" ? "Allow bash command?" : "Save allow rule for highlighted sub-command")),
					...(evaluation.commands.length === 0 ? ["✅ No executable commands detected"] : evaluation.commands.flatMap((item) => linesForCommand(item, innerWidth))),
					...(analysis.parserAvailable || !analysis.error
						? []
						: [divider, ...wrapPrefixed("⚠️ Parser error: ", analysis.error, innerWidth, (value) => theme.fg("warning", theme.bold(value)))]),
					"",
					...stageLines,
				];
				return [border("╭", "─", "╮"), ...lines.map(boxed), border("╰", "─", "╯")];
			},
			handleInput: (data: string) => {
				if (stage === "action") {
					if (data === "\x1b[A" || data === "\x1b[D") actionSelected = Math.max(0, actionSelected - 1);
					else if (data === "\x1b[B" || data === "\x1b[C") actionSelected = Math.min(actionChoices.length - 1, actionSelected + 1);
					else if (data === "\r" || data === "\n") {
						if (actionSelected === 0) return done({ type: "allow-once" });
						if (actionSelected === 1) return done({ type: "block" });
						stage = "save";
					} else if (data === "\x1b" || data === "\x03") return done(undefined);
					tui.requestRender();
					return;
				}

				if (data === "\x1b[A") scopeSelected = Math.max(0, scopeSelected - 1);
				else if (data === "\x1b[B") scopeSelected = Math.min(scopeChoices.length - 1, scopeSelected + 1);
				else if (data === "\t" || data === "\x1b[C" || data === "\x1b[D" || data === "\x1b[Z") {
					saveMode = saveMode === "exact" ? "regex" : "exact";
				} else if (data === "\r" || data === "\n") return done({ type: "save", scope: scopeChoices[scopeSelected]!, mode: saveMode });
				else if (data === "\x1b") stage = "action";
				else if (data === "\x03") return done(undefined);
				tui.requestRender();
			},
			invalidate: () => {},
		};
	}, { overlay: true });
}
