import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// tree-sitter and tree-sitter-bash are CommonJS packages without consistently
// available TS declarations in extension runtimes, so load them lazily via
// dynamic import and keep their values typed as any.
type BashRule = { source: string; regex: RegExp };
type BashCommandRisk = {
	command: string;
	name: string;
	harmless: boolean;
	reason: string;
	splitter?: string;
};

type BashAnalysis = {
	parserAvailable: boolean;
	commands: BashCommandRisk[];
	error?: string;
};

const WRITING_TOOLS = new Set(["write", "edit"]);
const READ_ONLY_COMMANDS = new Set([
	":",
	"true",
	"false",
	"pwd",
	"ls",
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"wc",
	"sort",
	"uniq",
	"cut",
	"diff",
	"cmp",
	"comm",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"awk",
	"sed",
	"find",
	"stat",
	"file",
	"du",
	"df",
	"ps",
	"date",
	"whoami",
	"id",
	"uname",
	"which",
	"whereis",
	"type",
	"command",
	"echo",
	"printf",
	"test",
	"[",
	"git",
]);
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
	"status",
	"diff",
	"log",
	"show",
	"branch",
	"tag",
	"rev-parse",
	"rev-list",
	"ls-files",
	"ls-tree",
	"grep",
	"blame",
	"remote",
]);
const FIND_MUTATING_FLAGS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf"]);
let bashParserPromise: Promise<any | null> | undefined;

function stripAtPrefix(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isInside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel));
}

async function realpathOrResolve(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

// Canonicalize existing paths, and for new files canonicalize the nearest
// existing parent. This prevents `cwd/link-to-/tmp/file` from being treated as
// inside CWD just because the textual path starts with CWD.
async function canonicalizeForPolicy(absolutePath: string): Promise<string> {
	let current = absolutePath;
	const missingParts: string[] = [];

	while (true) {
		try {
			const real = await realpath(current);
			return missingParts.length === 0 ? real : resolve(real, ...missingParts);
		} catch {
			const parent = dirname(current);
			if (parent === current) return resolve(absolutePath);
			missingParts.unshift(basename(current));
			current = parent;
		}
	}
}

function addExactRule(command: string, rules: BashRule[]): BashRule {
	const source = `^${escapeRegExp(command)}$`;
	const rule = { source, regex: new RegExp(source) };
	rules.push(rule);
	return rule;
}

function allowedByBashRules(command: string, rules: BashRule[]): BashRule | undefined {
	return rules.find((rule) => {
		rule.regex.lastIndex = 0;
		return rule.regex.test(command);
	});
}

async function confirmFileMutation(ctx: any, toolName: string, requestedPath: string, targetReal: string, cwdReal: string) {
	if (!ctx.hasUI) return { block: true, reason: `Write/edit outside CWD blocked: ${targetReal}` } as const;

	const ok = await ctx.ui.confirm(
		"Allow write outside CWD?",
		`Tool: ${toolName}\nRequested path: ${requestedPath}\nResolved path: ${targetReal}\nCWD: ${cwdReal}\n\nAllow this file mutation?`,
	);

	return ok ? undefined : ({ block: true, reason: "Blocked by user" } as const);
}

async function getBashParser(): Promise<any | null> {
	bashParserPromise ??= (async () => {
		try {
			const ParserModule = await import("tree-sitter");
			const BashModule = await import("tree-sitter-bash");
			const Parser = (ParserModule as any).default ?? ParserModule;
			const Bash = (BashModule as any).default ?? BashModule;
			const parser = new Parser();
			parser.setLanguage(Bash);
			return parser;
		} catch {
			return null;
		}
	})();
	return bashParserPromise;
}

function stripShellQuotes(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === "'" && last === "'") || (first === '"' && last === '"')) return value.slice(1, -1);
	}
	return value;
}

function hasWritingRedirectNode(node: any): boolean {
	if (node.type === "file_redirect") {
		return (node.children ?? []).some((child: any) => [">", ">>", "&>", "&>>", "<>", ">&"].includes(child.type));
	}
	return (node.children ?? []).some((child: any) => hasWritingRedirectNode(child));
}

function getCommandName(node: any): string | null {
	const fieldName = node.childForFieldName?.("name");
	if (fieldName?.text) return stripShellQuotes(fieldName.text).toLowerCase();

	for (const child of node.children ?? []) {
		if (child.type === "variable_assignment") continue;
		if (child.type === "command_name" || child.type === "word") return stripShellQuotes(child.text).toLowerCase();
	}
	return null;
}

function getCommandArgs(node: any): string[] {
	const args: string[] = [];
	let foundName = false;
	for (const child of node.children ?? []) {
		if (child.type === "variable_assignment") continue;
		if (!foundName && (child.type === "command_name" || child.type === "word")) {
			foundName = true;
			continue;
		}
		if (["word", "string", "raw_string", "number", "concatenation", "expansion"].includes(child.type)) {
			args.push(stripShellQuotes(child.text));
		}
	}
	return args;
}

function getCommandSegmentNode(node: any): any {
	return node.parent?.type === "redirected_statement" ? node.parent : node;
}

function riskForCommand(node: any, splitter?: string): BashCommandRisk {
	const segmentNode = getCommandSegmentNode(node);
	const command = segmentNode.text.trim();
	const name = getCommandName(node) ?? "assignment";
	const args = getCommandArgs(node);
	const withSplitter = (risk: Omit<BashCommandRisk, "splitter">): BashCommandRisk =>
		splitter ? { ...risk, splitter } : risk;

	if (hasWritingRedirectNode(segmentNode)) {
		return withSplitter({ command, name, harmless: false, reason: "writes via shell redirection" });
	}
	if (name === "assignment") return withSplitter({ command, name, harmless: true, reason: "variable assignment only" });
	if (!READ_ONLY_COMMANDS.has(name)) return withSplitter({ command, name, harmless: false, reason: `unknown or mutating command: ${name}` });

	if (name === "git") {
		const subcommand = args.find((arg) => !arg.startsWith("-"));
		if (!subcommand) return withSplitter({ command, name, harmless: true, reason: "git without mutating subcommand" });
		return GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)
			? withSplitter({ command, name, harmless: true, reason: `read-only git ${subcommand}` })
			: withSplitter({ command, name, harmless: false, reason: `potentially mutating git ${subcommand}` });
	}

	if (name === "find") {
		const mutatingFlag = args.find((arg) => FIND_MUTATING_FLAGS.has(arg));
		return mutatingFlag
			? withSplitter({ command, name, harmless: false, reason: `find uses ${mutatingFlag}` })
			: withSplitter({ command, name, harmless: true, reason: "find without mutating actions" });
	}

	if (name === "sed") {
		const mutatingFlag = args.find((arg) => arg === "-i" || arg.startsWith("-i"));
		const writesFile = args.some((arg) => /(^|;)\s*w\s+\S+/.test(arg));
		if (mutatingFlag) return withSplitter({ command, name, harmless: false, reason: "sed in-place edit" });
		if (writesFile) return withSplitter({ command, name, harmless: false, reason: "sed write command" });
	}

	if (name === "awk" && args.some((arg) => /system\s*\(/.test(arg) || />/.test(arg))) {
		return withSplitter({ command, name, harmless: false, reason: "awk may execute commands or write files" });
	}

	if (name === "command" && !(args[0] === "-v" || args[0] === "-V")) {
		return withSplitter({ command, name, harmless: false, reason: "command builtin may dispatch a mutating command" });
	}

	return withSplitter({ command, name, harmless: true, reason: "known read-only command" });
}

function collectCommandNodes(node: any, output: any[]) {
	if (node.type === "command" || node.type === "declaration_command") {
		output.push(node);
	}
	for (const child of node.children ?? []) collectCommandNodes(child, output);
}

async function analyzeBash(command: string): Promise<BashAnalysis> {
	const parser = await getBashParser();
	if (!parser) {
		return {
			parserAvailable: false,
			commands: [{ command, name: "unknown", harmless: false, reason: "tree-sitter bash parser unavailable" }],
		};
	}

	try {
		const tree = parser.parse(command);
		const nodes: any[] = [];
		collectCommandNodes(tree.rootNode, nodes);
		const sortedNodes = nodes.sort((a, b) => a.startIndex - b.startIndex);
		let previousEnd = 0;
		const commands = sortedNodes.map((node) => {
			const splitter = command.slice(previousEnd, node.startIndex).trim();
			previousEnd = getCommandSegmentNode(node).endIndex;
			return riskForCommand(node, splitter || undefined);
		});
		return { parserAvailable: true, commands };
	} catch (error: any) {
		return {
			parserAvailable: false,
			error: error?.message,
			commands: [{ command, name: "unknown", harmless: false, reason: "failed to parse bash command" }],
		};
	}
}

function formatBashAnalysis(analysis: BashAnalysis): string {
	const normal = "\x1b[0m";
	const warningBold = "\x1b[1;33m";
	if (analysis.commands.length === 0) return `${normal}✅ No executable commands detected`;
	const lines = analysis.commands.map((item) => {
		const prefix = item.harmless ? "✅" : "⚠️";
		const splitter = item.splitter ? `${item.splitter} ` : "";
		const command = `${splitter}${item.command}`;
		return item.harmless ? `${normal}${prefix} ${command}` : `${normal}${prefix} ${warningBold}${command}${normal}`;
	});
	if (!analysis.parserAvailable && analysis.error) lines.push(`${normal}⚠️ ${warningBold}Parser error: ${analysis.error}${normal}`);
	return lines.join("\n");
}

async function selectBashDecision(ctx: any, command: string, analysis: BashAnalysis): Promise<string | undefined> {
	const choices = ["Allow once", "Block", "Allow exact command for this session", "Add regex allow rule for this session..."];

	return ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: (value: string | undefined) => void) => {
		let selected = 0;
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
		const truncate = (value: string, width: number) => {
			if (visibleWidth(value) <= width) return value;
			let output = "";
			let used = 0;
			const limit = Math.max(0, width - 1);
			for (let index = 0; index < value.length;) {
				const ansi = value.slice(index).match(ansiPattern);
				if (ansi) {
					output += ansi[0];
					index += ansi[0].length;
					continue;
				}
				const char = Array.from(value.slice(index))[0] ?? "";
				const nextWidth = charWidth(char);
				if (used + nextWidth > limit) break;
				output += char;
				used += nextWidth;
				index += char.length;
			}
			return `${output}…\x1b[0m`;
		};
		const pad = (value: string, width: number) => `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
		const lineForCommand = (item: BashCommandRisk) => {
			const prefix = item.harmless ? "✅" : "⚠️";
			const splitter = item.splitter ? `${item.splitter} ` : "";
			const text = `${prefix} ${splitter}${item.command}`;
			return item.harmless ? text : `${prefix} ${theme.fg("warning", theme.bold(`${splitter}${item.command}`))}`;
		};

		return {
			render: (width: number) => {
				// Leave a generous safety margin because terminal emoji width can vary
				// between fonts/platforms; otherwise side borders can wrap/clobber.
				const boxWidth = Math.max(24, width - 12);
				const innerWidth = Math.max(1, boxWidth - 4);
				const border = (left: string, fill: string, right: string) => theme.fg("borderAccent", `${left}${fill.repeat(innerWidth + 2)}${right}`);
				const boxed = (line: string) => theme.fg("borderAccent", "│ ") + pad(truncate(line, innerWidth), innerWidth) + theme.fg("borderAccent", " │");
				const lines = [
					theme.fg("accent", theme.bold("Allow bash command?")),
					"",
					command,
					"",
					theme.fg("accent", "Command risk analysis:"),
					...(analysis.commands.length === 0 ? ["✅ No executable commands detected"] : analysis.commands.map(lineForCommand)),
					...(analysis.parserAvailable || !analysis.error ? [] : [`⚠️ ${theme.fg("warning", theme.bold(`Parser error: ${analysis.error}`))}`]),
					"",
					...choices.map((choice, index) => `${index === selected ? "→" : " "} ${choice}`),
					"",
					theme.fg("dim", "↑↓ navigate   enter select   escape/ctrl+c cancel"),
				];
				return [border("╭", "─", "╮"), ...lines.map(boxed), border("╰", "─", "╯")];
			},
			handleInput: (data: string) => {
				if (data === "\x1b[A") selected = Math.max(0, selected - 1);
				else if (data === "\x1b[B") selected = Math.min(choices.length - 1, selected + 1);
				else if (data === "\r" || data === "\n") return done(choices[selected]);
				else if (data === "\x1b" || data === "\x03") return done(undefined);
				tui.requestRender();
			},
			invalidate: () => {},
		};
	}, { overlay: true });
}

async function confirmBash(ctx: any, command: string, bashAllowRules: BashRule[]) {
	const analysis = await analyzeBash(command);
	const allHarmless = analysis.commands.every((item) => item.harmless);
	if (allHarmless) {
		if (ctx.hasUI) ctx.ui.notify(`Allowed harmless bash command:\n${formatBashAnalysis(analysis)}`, "info");
		return undefined;
	}

	if (!ctx.hasUI) {
		return {
			block: true,
			reason: `Bash command blocked because no UI is available for confirmation.\n${formatBashAnalysis(analysis)}`,
		} as const;
	}

	const choice = await selectBashDecision(ctx, command, analysis);

	if (choice === "Allow once") return undefined;

	if (choice === "Allow exact command for this session") {
		addExactRule(command, bashAllowRules);
		ctx.ui.notify("Added exact bash allow rule for this session.", "info");
		return undefined;
	}

	if (choice === "Add regex allow rule for this session...") {
		const source = await ctx.ui.input("Bash allow regex", "Example: ^ssh\\b");
		if (!source) return { block: true, reason: "Blocked by user" } as const;

		try {
			const regex = new RegExp(source);
			bashAllowRules.push({ source, regex });
			ctx.ui.notify(`Added bash allow rule: /${source}/`, "info");

			regex.lastIndex = 0;
			if (regex.test(command)) return undefined;
			return { block: true, reason: `Added regex /${source}/ does not match this command` } as const;
		} catch (error: any) {
			ctx.ui.notify(`Invalid regex: ${error.message}`, "error");
			return { block: true, reason: `Invalid regex: ${error.message}` } as const;
		}
	}

	return { block: true, reason: "Blocked by user" } as const;
}

export default function simplePermissions(pi: ExtensionAPI) {
	const bashAllowRules: BashRule[] = [];

	pi.registerCommand("perm-allow", {
		description: "Allow matching bash commands for this session. Usage: /perm-allow <regex>",
		handler: async (args, ctx) => {
			const source = args.trim();
			if (!source) {
				ctx.ui.notify("Usage: /perm-allow <regex>  e.g. /perm-allow ^ssh\\b", "warning");
				return;
			}

			try {
				const regex = new RegExp(source);
				bashAllowRules.push({ source, regex });
				ctx.ui.notify(`Added bash allow rule #${bashAllowRules.length}: /${source}/`, "info");
			} catch (error: any) {
				ctx.ui.notify(`Invalid regex: ${error.message}`, "error");
			}
		},
	});

	pi.registerCommand("perm-allow-exact", {
		description: "Allow one exact bash command for this session. Usage: /perm-allow-exact <command>",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command) {
				ctx.ui.notify("Usage: /perm-allow-exact <command>", "warning");
				return;
			}

			addExactRule(command, bashAllowRules);
			ctx.ui.notify(`Added exact bash allow rule #${bashAllowRules.length}`, "info");
		},
	});

	pi.registerCommand("perm-list", {
		description: "List current session bash allow rules",
		handler: async (_args, ctx) => {
			if (bashAllowRules.length === 0) {
				ctx.ui.notify("No bash allow rules for this session.", "info");
				return;
			}

			ctx.ui.notify(bashAllowRules.map((rule, index) => `${index + 1}. /${rule.source}/`).join("\n"), "info");
		},
	});

	pi.registerCommand("perm-clear", {
		description: "Clear session bash allow rules. Usage: /perm-clear [all|number]",
		handler: async (args, ctx) => {
			const target = args.trim();
			if (!target || target === "all") {
				bashAllowRules.splice(0, bashAllowRules.length);
				ctx.ui.notify("Cleared all bash allow rules.", "info");
				return;
			}

			const index = Number(target) - 1;
			if (!Number.isInteger(index) || index < 0 || index >= bashAllowRules.length) {
				ctx.ui.notify("Usage: /perm-clear [all|number]", "warning");
				return;
			}

			const [removed] = bashAllowRules.splice(index, 1);
			ctx.ui.notify(`Removed rule: /${removed.source}/`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus("simple-permissions", ctx.ui.theme.fg("accent", "perm: cwd-write + bash-risk"));
		}
	});

	pi.on("before_agent_start", async (event) => ({
		systemPrompt:
			event.systemPrompt +
			"\n\nPermission policy active: read/list/search tools are allowed; write/edit targets inside the current working directory are allowed; write/edit targets outside the current working directory require user confirmation; bash commands are parsed with tree-sitter-bash and each simple command is classified as harmless or potentially harmful. Fully harmless bash lines are allowed automatically; potentially harmful bash lines require user confirmation unless they match a session allow regex added by /perm-allow or by the bash confirmation dialog.",
	}));

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			const command = String((event.input as any).command ?? "");
			if (allowedByBashRules(command, bashAllowRules)) return undefined;
			return confirmBash(ctx, command, bashAllowRules);
		}

		if (!WRITING_TOOLS.has(event.toolName)) return undefined;

		const inputPath = (event.input as any).path;
		if (typeof inputPath !== "string") return undefined;

		const cwdReal = await realpathOrResolve(ctx.cwd);
		const absolutePath = resolve(ctx.cwd, stripAtPrefix(inputPath));
		const targetReal = await canonicalizeForPolicy(absolutePath);

		if (isInside(cwdReal, targetReal)) return undefined;

		return confirmFileMutation(ctx, event.toolName, inputPath, targetReal, cwdReal);
	});

	// Also gate user-typed ! / !! shell escapes. If you consider those already
	// explicit user consent, remove this handler.
	pi.on("user_bash", async (event, ctx) => {
		if (allowedByBashRules(event.command, bashAllowRules)) return undefined;

		const decision = await confirmBash(ctx, event.command, bashAllowRules);
		if (!decision) return undefined;

		return {
			result: {
				output: `Blocked by simple-permissions extension\n${decision.reason}\n`,
				exitCode: 1,
				cancelled: false,
				truncated: false,
			},
		};
	});
}
