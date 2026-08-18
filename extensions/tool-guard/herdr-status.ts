import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SOURCE = "custom:pi-tool-guard";
const AGENT = "pi";
const INPUT_MESSAGE = "Waiting for tool-guard approval";

type CommandRunner = (command: string, args: string[]) => Promise<void>;

function herdrCommand(env: NodeJS.ProcessEnv): string | undefined {
	if (env.HERDR_ENV !== "1" || !env.HERDR_PANE_ID) return undefined;
	return env.HERDR_BIN_PATH || "herdr";
}

async function runHerdr(command: string, args: string[]): Promise<void> {
	await execFileAsync(command, args, {
		timeout: 1_000,
		windowsHide: true,
	});
}

/**
 * Temporarily makes a tool-guard dialog visible to Herdr as an input block.
 * Herdr is intentionally optional: reporting failures must never prevent the
 * permission dialog from being shown.
 */
export async function withHerdrInputStatus<T>(
	prompt: () => Promise<T>,
	message = INPUT_MESSAGE,
	env: NodeJS.ProcessEnv = process.env,
	run: CommandRunner = runHerdr,
): Promise<T> {
	const command = herdrCommand(env);
	const paneId = env.HERDR_PANE_ID;
	if (!command || !paneId) return prompt();

	const baseArgs = [paneId, "--source", SOURCE, "--agent", AGENT];
	try {
		await run(command, ["pane", "report-agent", ...baseArgs, "--state", "blocked", "--message", message]);
	} catch {
		// Herdr may not be installed or its server may have stopped. The guard
		// must still work normally outside a healthy Herdr session.
	}

	try {
		return await prompt();
	} finally {
		try {
			await run(command, ["pane", "release-agent", ...baseArgs]);
		} catch {
			// Keep the prompt result/error authoritative if cleanup cannot report.
		}
	}
}
