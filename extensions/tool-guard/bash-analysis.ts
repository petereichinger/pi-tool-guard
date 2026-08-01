import {
	FD_EXEC_FLAGS,
	FD_SHORT_OPTIONS_WITH_VALUES,
	FIND_MUTATING_FLAGS,
	GIT_READ_ONLY_SUBCOMMANDS,
	READ_ONLY_COMMANDS,
} from "./constants.ts";
import { getBashParser } from "./tree-sitter.ts";
import type { BashAnalysis, BashCommandRisk } from "./types.ts";

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

function fdExecutingFlag(args: string[]): string | undefined {
	for (const arg of args) {
		if (arg === "--") return undefined;
		if (FD_EXEC_FLAGS.has(arg)) return arg;
		if (arg.startsWith("--exec=") || arg.startsWith("--exec-batch=")) return arg;
		if (!arg.startsWith("-") || arg.startsWith("--") || arg === "-") continue;

		for (let index = 1; index < arg.length; index += 1) {
			const flag = arg[index];
			if (flag === "x" || flag === "X") return arg;
			if (FD_SHORT_OPTIONS_WITH_VALUES.has(flag)) break;
		}
	}
	return undefined;
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

	if (name === "fd" || name === "fdfind") {
		const executingFlag = fdExecutingFlag(args);
		return executingFlag
			? withSplitter({ command, name, harmless: false, reason: `fd executes commands via ${executingFlag}` })
			: withSplitter({ command, name, harmless: true, reason: "fd without exec actions" });
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

const SSH_OPTIONS_WITH_VALUES = new Set([
	"B", "b", "c", "D", "E", "e", "F", "I", "i", "J", "L", "l", "m", "O", "o", "P", "p", "Q", "R", "S", "W", "w",
]);

/** Evaluate only shell words whose argv value is knowable without expansion. */
function staticShellWord(source: string): string | undefined {
	let result = "";
	let quote: "single" | "double" | undefined;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (quote === "single") {
			if (character === "'") quote = undefined;
			else result += character;
			continue;
		}
		if (quote === "double") {
			if (character === '"') {
				quote = undefined;
				continue;
			}
			if (character === "$" || character === "`") return undefined;
			if (character === "\\" && index + 1 < source.length) {
				const next = source[index + 1];
				if (next === "\n") {
					index += 1;
					continue;
				}
				if (["$", "`", '"', "\\"].includes(next)) {
					result += next;
					index += 1;
					continue;
				}
			}
			result += character;
			continue;
		}

		if (character === "'") quote = "single";
		else if (character === '"') quote = "double";
		else if (character === "\\" && index + 1 < source.length) {
			const next = source[++index];
			if (next !== "\n") result += next;
		}
		else if (character === "$" || character === "`" || "*?[{".includes(character) || (character === "~" && index === 0)) return undefined;
		else result += character;
	}
	return quote ? undefined : result;
}

function sshOptionConsumesNext(value: string): boolean {
	for (let index = 1; index < value.length; index += 1) {
		if (!SSH_OPTIONS_WITH_VALUES.has(value[index])) continue;
		return index === value.length - 1;
	}
	return false;
}

function commandArgumentNodes(node: any): any[] {
	const result: any[] = [];
	let foundName = false;
	for (const child of node.children ?? []) {
		if (child.type === "variable_assignment") continue;
		if (!foundName && (child.type === "command_name" || child.type === "word")) {
			foundName = true;
			continue;
		}
		if (foundName && child.isNamed && child.type !== "file_redirect") result.push(child);
	}
	return result;
}

/**
 * ssh passes all argv entries after the destination to a remote shell as one
 * space-joined string. Tree-sitter correctly sees those entries as arguments,
 * not as local shell commands, so separate the transport (through the host)
 * and reconstruct the remote command explicitly.
 */
function sshCommandParts(node: any): { transport: string; remote: string } | undefined {
	if (getCommandName(node) !== "ssh") return undefined;
	const args = commandArgumentNodes(node);
	let destinationNode: any | undefined;
	let consumeOptionValue = false;
	let index = 0;

	for (; index < args.length; index += 1) {
		const value = staticShellWord(args[index].text);
		if (value === undefined) return undefined;
		if (consumeOptionValue) {
			consumeOptionValue = false;
			continue;
		}
		if (value === "--") continue;
		if (value.startsWith("-") && value !== "-") {
			consumeOptionValue = sshOptionConsumesNext(value);
			continue;
		}
		destinationNode = args[index];
		index += 1;
		break;
	}
	if (!destinationNode || consumeOptionValue || index >= args.length) return undefined;

	const remoteArgs: string[] = [];
	for (; index < args.length; index += 1) {
		const value = staticShellWord(args[index].text);
		if (value === undefined) return undefined;
		remoteArgs.push(value);
	}
	const remote = remoteArgs.join(" ").trim();
	if (!remote) return undefined;
	const transportEnd = destinationNode.endIndex - node.startIndex;
	return { transport: node.text.slice(0, transportEnd).trim(), remote };
}

function risksForParsedCommand(command: string, parser: any, depth = 0): BashCommandRisk[] {
	const tree = parser.parse(command);
	const nodes: any[] = [];
	collectCommandNodes(tree.rootNode, nodes);
	const sortedNodes = nodes.sort((a, b) => a.startIndex - b.startIndex);
	let previousEnd = 0;
	const risks: BashCommandRisk[] = [];
	for (const node of sortedNodes) {
		const splitter = command.slice(previousEnd, node.startIndex).trim();
		previousEnd = getCommandSegmentNode(node).endIndex;
		let risk = riskForCommand(node, splitter || undefined);
		const sshParts = depth < 4 ? sshCommandParts(node) : undefined;
		if (sshParts) risk = { ...risk, command: sshParts.transport };
		risks.push(risk);

		if (!sshParts) continue;
		const remoteRisks = risksForParsedCommand(sshParts.remote, parser, depth + 1);
		if (remoteRisks.length > 0) {
			remoteRisks[0] = { ...remoteRisks[0], splitter: "ssh remote →" };
			risks.push(...remoteRisks);
		}
	}
	return risks;
}

export async function analyzeBash(command: string): Promise<BashAnalysis> {
	const { parser, error: loadError } = await getBashParser();
	if (!parser) {
		return {
			parserAvailable: false,
			error: loadError,
			commands: [{ command, name: "unknown", harmless: false, reason: `tree-sitter bash parser unavailable${loadError ? `: ${loadError.split("\n")[0]}` : ""}` }],
		};
	}

	try {
		return { parserAvailable: true, commands: risksForParsedCommand(command, parser) };
	} catch (error: any) {
		return {
			parserAvailable: false,
			error: error?.message,
			commands: [{ command, name: "unknown", harmless: false, reason: "failed to parse bash command" }],
		};
	}
}

export function formatBashAnalysis(analysis: BashAnalysis): string {
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
