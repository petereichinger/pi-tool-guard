import { dirname, resolve } from "node:path";
import { canonicalizeForPolicy, isInside, stripAtPrefix } from "./path-policy.ts";
import { formatDisplayedBashCommand } from "./rule-utils.ts";
import type {
	BashAnalysis,
	BashAnalysisEvaluation,
	BashDialogDecision,
	BashRuleScope,
	BashSaveMode,
	EvaluatedBashCommand,
	FileMutationDecision,
	FileMutationSaveMode,
	LoadedConfigState,
} from "./types.ts";

const ansiPattern = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[PX^_].*?\x1b\\|.)/;

function charWidth(char: string) {
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
}

function visibleWidth(value: string) {
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
}

function wrapPlain(value: string, width: number) {
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
}

function wrapPrefixed(prefix: string, content: string, width: number, style: (value: string) => string = (value) => value) {
	const prefixWidth = visibleWidth(prefix);
	const continuationPrefix = " ".repeat(prefixWidth);
	const contentWidth = Math.max(1, width - prefixWidth);
	const wrappedContent = wrapPlain(content, contentWidth);
	return wrappedContent.map((line, index) => `${index === 0 ? prefix : continuationPrefix}${style(line)}`);
}

type InlineChoice<T> = {
	label: string;
	description: string;
	value: T;
};

function renderInlineChoices<T>(theme: any, choices: InlineChoice<T>[], selectedIndex: number, width: number) {
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;
	for (const [index, choice] of choices.entries()) {
		const plain = index === selectedIndex ? `[${choice.label}]` : choice.label;
		const rendered = index === selectedIndex ? theme.fg("accent", theme.bold(plain)) : theme.fg("muted", plain);
		const separator = current.length === 0 ? "" : "  ";
		const nextWidth = currentWidth + visibleWidth(separator) + visibleWidth(plain);
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
}

function renderChoicePrompt<T>(theme: any, title: string, bodyLines: string[], choices: InlineChoice<T>[], selectedIndex: number, width: number) {
	const innerWidth = Math.max(1, width);
	return [
		theme.fg("accent", theme.bold(title)),
		...bodyLines,
		"",
		...renderInlineChoices(theme, choices, selectedIndex, innerWidth),
		...wrapPrefixed("", choices[selectedIndex]?.description ?? "", innerWidth, (value) => theme.fg("dim", value)),
		"",
		...wrapPrefixed("", "←→ or ↑↓ navigate   enter select   escape/ctrl+c deny", innerWidth, (value) => theme.fg("dim", value)),
	];
}

function previousSelected(current: number) {
	return Math.max(0, current - 1);
}

function nextSelected(current: number, count: number) {
	return Math.min(count - 1, current + 1);
}

function isPreviousKey(data: string) {
	return data === "\x1b[A" || data === "\x1b[D";
}

function isNextKey(data: string) {
	return data === "\x1b[B" || data === "\x1b[C";
}

function kittyCsiU(data: string): { codepoint: number; modifier: number } | undefined {
	const match = data.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?(?:;(\d+))?(?::\d+)?u$/);
	if (!match) return undefined;
	return { codepoint: Number(match[1]), modifier: (match[2] ? Number(match[2]) : 1) - 1 };
}

function modifyOtherKey(data: string): { codepoint: number; modifier: number } | undefined {
	const match = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
	if (!match) return undefined;
	return { codepoint: Number(match[2]), modifier: Number(match[1]) - 1 };
}

function hasCtrlModifier(modifier: number) {
	return (modifier & 4) !== 0;
}

function isEnterKey(data: string) {
	const kitty = kittyCsiU(data);
	return data === "\r" || data === "\n" || data === "\x1bOM" || (!!kitty && (kitty.codepoint === 13 || kitty.codepoint === 57414) && kitty.modifier === 0);
}

function isDenyKey(data: string) {
	const kitty = kittyCsiU(data);
	const modified = modifyOtherKey(data);
	return data === "\x1b" ||
		data === "\x03" ||
		(!!kitty && kitty.codepoint === 27 && kitty.modifier === 0) ||
		(!!kitty && kitty.codepoint === 3) ||
		(!!kitty && (kitty.codepoint === 99 || kitty.codepoint === 67) && hasCtrlModifier(kitty.modifier)) ||
		(!!modified && modified.codepoint === 27 && modified.modifier === 0) ||
		(!!modified && modified.codepoint === 3) ||
		(!!modified && (modified.codepoint === 99 || modified.codepoint === 67) && hasCtrlModifier(modified.modifier));
}

export async function editRegexRule(ctx: any, title: string, subCommand: string, initialValue: string): Promise<string | undefined> {
	return ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: (value: string | undefined) => void) => {
		let value = initialValue;
		let cursor = value.length;
		let forceShowInvalid = false;
		const validation = () => {
			try {
				new RegExp(value);
				return { valid: true } as const;
			} catch (error: any) {
				return { valid: false, message: error.message } as const;
			}
		};
		const moveLeft = () => {
			cursor = Math.max(0, cursor - 1);
		};
		const moveRight = () => {
			cursor = Math.min(value.length, cursor + 1);
		};
		const insert = (text: string) => {
			value = `${value.slice(0, cursor)}${text}${value.slice(cursor)}`;
			cursor += text.length;
			forceShowInvalid = false;
		};
		const backspace = () => {
			if (cursor === 0) return;
			value = `${value.slice(0, cursor - 1)}${value.slice(cursor)}`;
			cursor -= 1;
			forceShowInvalid = false;
		};
		const deleteForward = () => {
			if (cursor >= value.length) return;
			value = `${value.slice(0, cursor)}${value.slice(cursor + 1)}`;
			forceShowInvalid = false;
		};

		return {
			render: (width: number) => {
				const innerWidth = Math.max(1, width);
				const status = validation();
				const display = `${value.slice(0, cursor)}▌${value.slice(cursor)}`;
				return [
					theme.fg("accent", theme.bold(title)),
					...wrapPrefixed("Command: ", subCommand, innerWidth),
					"",
					...wrapPrefixed("Regex: ", display, innerWidth),
					...(status.valid
						? [theme.fg("success", "✅ Valid regex")]
						: wrapPrefixed("", `⚠️ Invalid regex: ${status.message}`, innerWidth, (line) => theme.fg(forceShowInvalid ? "error" : "warning", line))),
					"",
					...wrapPrefixed("", "enter save   escape/ctrl+c deny   ←→ move   backspace/delete edit", innerWidth, (line) => theme.fg("dim", line)),
				];
			},
			handleInput: (data: string) => {
				if (data === "\x1b[D") moveLeft();
				else if (data === "\x1b[C") moveRight();
				else if (data === "\x1b[H" || data === "\x01") cursor = 0;
				else if (data === "\x1b[F" || data === "\x05") cursor = value.length;
				else if (data === "\x7f" || data === "\b") backspace();
				else if (data === "\x1b[3~") deleteForward();
				else if (isEnterKey(data)) {
					if (validation().valid) return done(value);
					forceShowInvalid = true;
				} else if (isDenyKey(data)) return done(undefined);
				else if (data.length > 0 && !data.startsWith("\x1b")) insert(data);
				tui.requestRender();
			},
			invalidate: () => {},
		};
	});
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

	const targetDirectory = dirname(targetReal);
	const actionChoices: InlineChoice<FileMutationDecision>[] = [
		{ label: "Allow once", description: "Allow this file mutation one time.", value: { type: "allow-once" } },
		{ label: "Deny", description: "Block this file mutation.", value: { type: "block" } },
		{ label: "Add rule…", description: "Create a scoped write-directory allow rule.", value: { type: "save", scope: "session", mode: "folder" } },
	];
	const scopeChoices: BashRuleScope[] = ["session", "directory", ...(config.repoLocation ? (["repo"] as const) : []), "global"];

	const decision = await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: (value: FileMutationDecision) => void) => {
		let stage: "action" | "save" = "action";
		let actionSelected = 0;
		let scopeSelected = 0;
		let saveMode: FileMutationSaveMode = "folder";
		const scopeLabel = (scope: BashRuleScope) => `${scope[0]!.toUpperCase()}${scope.slice(1)}`;
		const modeLabel = (mode: FileMutationSaveMode, label: string) => {
			const active = saveMode === mode;
			const prefix = active ? "◉ " : "○ ";
			const text = `${prefix}${label}`;
			return active ? theme.fg("accent", text) : theme.fg("muted", text);
		};

		return {
			render: (width: number) => {
				const innerWidth = Math.max(1, width);
				const bodyLines = wrapPrefixed("", targetReal, innerWidth);
				if (stage === "action") return renderChoicePrompt(theme, "Allow write?", bodyLines, actionChoices, actionSelected, innerWidth);

				return [
					theme.fg("accent", theme.bold("Add write rule")),
					...bodyLines,
					"",
					...wrapPrefixed("", "Applies to future writes at or under the selected path. Tab or ←→ switches folder/custom. ↑↓ chooses scope.", innerWidth, (value) => theme.fg("dim", value)),
					"",
					theme.fg("accent", "Mode:"),
					`  ${modeLabel("folder", "Folder of this file")}`,
					`  ${modeLabel("custom", "Custom path")}`,
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
					...wrapPrefixed("", "enter save   escape/ctrl+c deny", innerWidth, (value) => theme.fg("dim", value)),
				];
			},
			handleInput: (data: string) => {
				if (stage === "action") {
					if (isPreviousKey(data)) actionSelected = previousSelected(actionSelected);
					else if (isNextKey(data)) actionSelected = nextSelected(actionSelected, actionChoices.length);
					else if (isEnterKey(data)) {
						const choice = actionChoices[actionSelected]!.value;
						if (choice.type !== "save") return done(choice);
						stage = "save";
					} else if (isDenyKey(data)) return done({ type: "block" });
					tui.requestRender();
					return;
				}

				if (data === "\x1b[A") scopeSelected = previousSelected(scopeSelected);
				else if (data === "\x1b[B") scopeSelected = nextSelected(scopeSelected, scopeChoices.length);
				else if (data === "\t" || data === "\x1b[C" || data === "\x1b[D" || data === "\x1b[Z") {
					saveMode = saveMode === "folder" ? "custom" : "folder";
				} else if (isEnterKey(data)) return done({ type: "save", scope: scopeChoices[scopeSelected]!, mode: saveMode });
				else if (isDenyKey(data)) return done({ type: "block" });
				tui.requestRender();
			},
			invalidate: () => {},
		};
	});

	if (!decision || decision.type === "block") return { block: true, reason: "Blocked by user" } as const;
	if (decision.type === "allow-once") return undefined;

	let allowedPath = targetDirectory;
	if (decision.mode === "custom") {
		const input = await ctx.ui.input("Path to allow writes under", targetDirectory);
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
): Promise<BashDialogDecision | undefined> {
	const actionChoices: InlineChoice<BashDialogDecision>[] = [
		{ label: "Allow once", description: "Allow the whole bash command for this run.", value: { type: "allow-once" } },
		{ label: "Deny", description: "Block this bash command.", value: { type: "block" } },
		{ label: "Save allow rule…", description: "Create an allow rule for the highlighted sub-command.", value: { type: "save", scope: "session", mode: "exact" } },
	];
	const scopeChoices: BashRuleScope[] = ["session", "directory", ...(config.repoLocation ? (["repo"] as const) : []), "global"];

	return ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: (value: BashDialogDecision | undefined) => void) => {
		let stage: "action" | "save" = initialStage;
		let actionSelected = 0;
		let scopeSelected = 0;
		let saveMode: BashSaveMode = "exact";
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

		return {
			render: (width: number) => {
				const innerWidth = Math.max(1, width);
				const divider = theme.fg("dim", "─".repeat(Math.min(innerWidth, 40)));
				const bodyLines = [
					...(evaluation.commands.length === 0 ? ["✅ No executable commands detected"] : evaluation.commands.flatMap((item) => linesForCommand(item, innerWidth))),
					...(analysis.parserAvailable || !analysis.error
						? []
						: [divider, ...wrapPrefixed("⚠️ Parser error: ", analysis.error, innerWidth, (value) => theme.fg("warning", theme.bold(value)))]),
				];
				if (stage === "action") {
					return renderChoicePrompt(theme, "Allow bash command?", bodyLines, actionChoices, actionSelected, innerWidth);
				}

				return [
					theme.fg("accent", theme.bold("Save allow rule for highlighted sub-command")),
					...bodyLines,
					"",
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
					...wrapPrefixed("", "enter save   escape/ctrl+c deny", innerWidth, (value) => theme.fg("dim", value)),
				];
			},
			handleInput: (data: string) => {
				if (stage === "action") {
					if (isPreviousKey(data)) actionSelected = previousSelected(actionSelected);
					else if (isNextKey(data)) actionSelected = nextSelected(actionSelected, actionChoices.length);
					else if (isEnterKey(data)) {
						const choice = actionChoices[actionSelected]!.value;
						if (choice.type !== "save") return done(choice);
						stage = "save";
					} else if (isDenyKey(data)) return done({ type: "block" });
					tui.requestRender();
					return;
				}

				if (data === "\x1b[A") scopeSelected = previousSelected(scopeSelected);
				else if (data === "\x1b[B") scopeSelected = nextSelected(scopeSelected, scopeChoices.length);
				else if (data === "\t" || data === "\x1b[C" || data === "\x1b[D" || data === "\x1b[Z") {
					saveMode = saveMode === "exact" ? "regex" : "exact";
				} else if (isEnterKey(data)) return done({ type: "save", scope: scopeChoices[scopeSelected]!, mode: saveMode });
				else if (isDenyKey(data)) return done({ type: "block" });
				tui.requestRender();
			},
			invalidate: () => {},
		};
	});
}
