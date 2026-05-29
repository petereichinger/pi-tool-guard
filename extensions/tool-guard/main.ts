import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { confirmBash } from "./bash-confirm.ts";
import { registerGuardCommands } from "./commands.ts";
import { WRITING_TOOLS, SESSION_RULES_ENTRY_TYPE } from "./constants.ts";
import { loadConfigs } from "./config-store.ts";
import { canonicalizeForPolicy, isInside, realpathOrResolve, stripAtPrefix } from "./path-policy.ts";
import { persistedSessionRules, loadSessionRules } from "./session-rules.ts";
import { confirmFileMutation } from "./ui.ts";
import type { BashRule } from "./types.ts";

const POLICY_PROMPT =
	"\n\nPermission policy active: read/list/search tools are allowed; write/edit targets inside the current working directory are allowed; write/edit targets outside the current working directory require user confirmation; agent bash tool calls are parsed with tree-sitter-bash and each simple command is classified as harmless or potentially harmful. Bash allow/deny rules apply to each parsed sub-command, not the whole line. Fully harmless bash lines are allowed automatically unless a deny rule matches one of their parsed sub-commands. Potentially harmful sub-commands require approval unless they match a session, directory, repo, or global allow regex. Matching deny regexes override allows and block the bash tool call.";

export default function toolGuard(pi: ExtensionAPI) {
	const bashAllowRules: BashRule[] = [];
	const bashDenyRules: BashRule[] = [];
	let sessionRuleErrors: string[] = [];

	const saveSessionRules = () => {
		sessionRuleErrors = [];
		pi.appendEntry(SESSION_RULES_ENTRY_TYPE, persistedSessionRules(bashAllowRules, bashDenyRules));
	};

	const replaceSessionRules = (allowRules: BashRule[], denyRules: BashRule[]) => {
		bashAllowRules.splice(0, bashAllowRules.length, ...allowRules);
		bashDenyRules.splice(0, bashDenyRules.length, ...denyRules);
	};

	registerGuardCommands(pi, {
		bashAllowRules,
		bashDenyRules,
		saveSessionRules,
		getSessionRuleErrors: () => sessionRuleErrors,
	});

	pi.on("session_start", async (_event, ctx) => {
		const session = loadSessionRules(ctx);
		replaceSessionRules(session.allowRules, session.denyRules);
		sessionRuleErrors = session.errors;
		const config = await loadConfigs(ctx.cwd);
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
			const config = await loadConfigs(ctx.cwd);
			return confirmBash(ctx, command, bashAllowRules, bashDenyRules, config, saveSessionRules);
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
}
