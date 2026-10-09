import { resolve } from "node:path";
import { physicalShellPath, shellDirectory } from "./shell-path.ts";
import { staticShellWord } from "./shell-word.ts";

export type BashCommandContext = { cwd: string; env: Record<string, string | undefined> };
type Outcomes = { success?: BashCommandContext; failure?: BashCommandContext };

const SHELL_CONTEXT_COMMANDS = new Set([
	".", "source", "eval", "exec", "command", "builtin", "export", "unset", "set", "shopt",
	"declare", "typeset", "local", "readonly", "read", "readarray", "mapfile", "printf", "let",
	"getopts", "shift", "pushd", "popd", "alias", "unalias", "enable", "hash", "trap", "fc", "bind",
]);

function commandName(node: any): string | undefined {
	const name = node.childForFieldName?.("name");
	return name ? staticShellWord(name.text) : undefined;
}

function merge(a: BashCommandContext | undefined, b: BashCommandContext | undefined): BashCommandContext | undefined {
	if (a === b) return a;
	if (!a || !b || a.cwd !== b.cwd) return undefined;
	return Object.keys({ ...a.env, ...b.env }).every((key) => a.env[key] === b.env[key]) ? a : undefined;
}

async function cdDestination(node: any, context: BashCommandContext | undefined): Promise<BashCommandContext | undefined> {
	if (!context || context.env.CDPATH || node.hasError) return undefined;
	const { cwd, env } = context;
	const name = node.childForFieldName("name");
	const children = node.namedChildren ?? [];
	if (children.some((child: any) => child.type === "variable_assignment")) return undefined;
	let physical = false;
	let optionsEnded = false;
	let destination: string | undefined;
	for (const child of children) {
		if (child === name) continue;
		const value = staticShellWord(child.text, env);
		if (value === undefined) return undefined;
		if (!optionsEnded && value === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && /^-[LPe]+$/.test(value)) {
			for (const flag of value.slice(1)) {
				if (flag === "P") physical = true;
				else if (flag === "L") physical = false;
			}
			continue;
		}
		if ((!optionsEnded && value.startsWith("-")) || destination !== undefined) return undefined;
		destination = value;
	}
	if (!destination) return undefined;
	try {
		const base = physical ? await shellDirectory(cwd) : cwd;
		const path = physicalShellPath(base, destination);
		const nextCwd = physical ? await shellDirectory(path) : resolve(path);
		if (!physical) await shellDirectory(nextCwd);
		return { cwd: nextCwd, env: { ...env, PWD: nextCwd.replaceAll("\\", "/"), OLDPWD: cwd.replaceAll("\\", "/") } };
	} catch {
		return undefined;
	}
}

export async function bashCommandContexts(root: any, cwd?: string): Promise<Map<number, BashCommandContext | undefined>> {
	const contexts = new Map<number, BashCommandContext | undefined>();
	const markUnknown = (node: any) => {
		if (node.type === "command" || node.type === "declaration_command") contexts.set(node.startIndex, undefined);
		for (const child of node.namedChildren ?? []) markUnknown(child);
	};
	const visit = async (node: any, current: BashCommandContext | undefined): Promise<Outcomes> => {
		if (node.hasError) {
			markUnknown(node);
			return {};
		}
		if (node.type === "program") {
			let state = current;
			for (const child of node.namedChildren ?? []) {
				if (child.type === "comment") continue;
				const outcomes = await visit(child, state);
				state = merge(outcomes.success, outcomes.failure);
			}
			return { success: state, failure: state };
		}
		if (node.type === "list") {
			const [left, right] = (node.namedChildren ?? []).filter((child: any) => child.type !== "comment");
			const operator = (node.children ?? []).find((child: any) => child.type === "&&" || child.type === "||")?.type;
			if (!left || !right || !operator) {
				markUnknown(node);
				return {};
			}
			const before = await visit(left, current);
			const after = await visit(right, operator === "&&" ? before.success : before.failure);
			return operator === "&&"
				? { success: after.success, failure: merge(before.failure, after.failure) }
				: { success: merge(before.success, after.success), failure: after.failure };
		}
		if (node.type === "redirected_statement") {
			const command = node.namedChildren?.[0];
			const redirects = (node.namedChildren ?? []).filter((child: any) => child.type === "file_redirect");
			const staticRedirects = redirects.every((redirect: any) => {
				const destination = redirect.childForFieldName("destination");
				return destination && staticShellWord(destination.text, current?.env) !== undefined;
			});
			if (command?.type === "command" && staticRedirects && (node.namedChildren ?? []).every((child: any) => child === command || child.type === "file_redirect")) {
				const outcomes = await visit(command, current);
				return { success: outcomes.success, failure: merge(current, outcomes.failure) };
			}
		}
		if (node.type === "command" && !node.descendantsOfType("command_substitution").length) {
			contexts.set(node.startIndex, current);
			const name = commandName(node);
			if (name === "cd") return { success: await cdDestination(node, current), failure: current };
			const changesContext = !name || SHELL_CONTEXT_COMMANDS.has(name) ||
				(node.namedChildren ?? []).some((child: any) => child.type === "variable_assignment" || staticShellWord(child.text, current?.env) === undefined);
			const state = changesContext ? undefined : current;
			return { success: state, failure: state };
		}
		markUnknown(node);
		return {};
	};
	await visit(root, cwd ? { cwd, env: { ...process.env, PWD: cwd.replaceAll("\\", "/") } } : undefined);
	return contexts;
}
