import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { confirmBash } from "./bash-confirm.ts";
import { registerGuardCommands } from "./commands.ts";
import { WRITING_TOOLS, SESSION_RULES_ENTRY_TYPE } from "./constants.ts";
import { addPersistentWriteDirectory, loadConfigs } from "./config-store.ts";
import { canonicalizeForPolicy, isInside, realpathOrResolve, stripAtPrefix } from "./path-policy.ts";
import { persistedSessionRules, loadSessionRules } from "./session-rules.ts";
import { setupTerminalFocusTracking } from "./terminal-focus.ts";
import { confirmFileMutation } from "./ui.ts";
import type { BashRule, BashRuleScope, PersistentBashRuleScope } from "./types.ts";

const POLICY_PROMPT =
	"\n\nPermission policy active: read/list/search tools are allowed; write/edit targets inside the current working directory are allowed; write/edit targets outside the current working directory require user confirmation unless they are under a scoped write-directory allow rule; agent bash tool calls are parsed with tree-sitter-bash and each simple command is classified as harmless or potentially harmful. Bash allow/deny rules apply to each parsed sub-command, not the whole line. Fully harmless bash lines are allowed automatically unless a deny rule matches one of their parsed sub-commands. Potentially harmful sub-commands require approval unless they match a session, directory, repo, or global allow regex. Matching deny regexes override allows and block the bash tool call.";

export default function toolGuard(pi: ExtensionAPI) {
	const bashAllowRules: BashRule[] = [];
	const bashDenyRules: BashRule[] = [];
	const writeAllowDirectories: string[] = [];
	let sessionRuleErrors: string[] = [];

	const saveSessionRules = () => {
		sessionRuleErrors = [];
		pi.appendEntry(SESSION_RULES_ENTRY_TYPE, persistedSessionRules(bashAllowRules, bashDenyRules, writeAllowDirectories));
	};

	const replaceSessionRules = (allowRules: BashRule[], denyRules: BashRule[], allowDirectories: string[]) => {
		bashAllowRules.splice(0, bashAllowRules.length, ...allowRules);
		bashDenyRules.splice(0, bashDenyRules.length, ...denyRules);
		writeAllowDirectories.splice(0, writeAllowDirectories.length, ...allowDirectories);
	};

	const addWriteAllowDirectory = async (ctx: any, scope: BashRuleScope, path: string) => {
		if (scope === "session") {
			if (!writeAllowDirectories.includes(path)) writeAllowDirectories.push(path);
			saveSessionRules();
			return;
		}
		await addPersistentWriteDirectory(ctx, scope as PersistentBashRuleScope, path);
	};

	registerGuardCommands(pi, {
		bashAllowRules,
		bashDenyRules,
		writeAllowDirectories,
		saveSessionRules,
		getSessionRuleErrors: () => sessionRuleErrors,
	});

	pi.on("session_start", async (_event, ctx) => {
		setupTerminalFocusTracking(ctx);
		const session = loadSessionRules(ctx);
		const writeAllowDirectoryRules = await Promise.all(
			session.writeAllowDirectories.map((path) => canonicalizeForPolicy(resolve(ctx.cwd, stripAtPrefix(path)))),
		);
		replaceSessionRules(session.allowRules, session.denyRules, writeAllowDirectoryRules);
		sessionRuleErrors = session.errors;
		const config = await loadConfigs(ctx);
		const warnings = [...sessionRuleErrors, ...config.errors];
		if (ctx.hasUI && warnings.length > 0) {
			ctx.ui.notify(`tool-guard warnings:\n${warnings.join("\n")}`, "warning");
		}
	});

	pi.on("before_agent_start", async (event) => ({
		systemPrompt: event.systemPrompt + POLICY_PROMPT,
	}));

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			const command = String((event.input as any).command ?? "");
			const config = await loadConfigs(ctx);
			return confirmBash(ctx, command, bashAllowRules, bashDenyRules, config, saveSessionRules);
		}

		if (!WRITING_TOOLS.has(event.toolName)) return undefined;

		const inputPath = (event.input as any).path;
		if (typeof inputPath !== "string") return undefined;

		const cwdReal = await realpathOrResolve(ctx.cwd);
		const absolutePath = resolve(ctx.cwd, stripAtPrefix(inputPath));
		const targetReal = await canonicalizeForPolicy(absolutePath);

		if (isInside(cwdReal, targetReal)) return undefined;
		if (writeAllowDirectories.some((directory) => isInside(directory, targetReal))) return undefined;

		const config = await loadConfigs(ctx);
		if (config.writeAllowDirectories.some((rule) => isInside(rule.path, targetReal))) return undefined;

		return confirmFileMutation(ctx, event.toolName, inputPath, targetReal, cwdReal, config, (scope, path) => addWriteAllowDirectory(ctx, scope, path));
	});
}
