import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SOURCE = "custom:pi-tool-guard";
const AGENT = "pi";
const INPUT_MESSAGE = "Waiting for tool-guard approval";

type CommandRunner = (command: string, args: string[]) => Promise<void>;

export type HerdrInputStatusReporter = (active: boolean, label?: string) => void;

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
	report?: HerdrInputStatusReporter,
	env: NodeJS.ProcessEnv = process.env,
	run: CommandRunner = runHerdr,
): Promise<T> {
	const command = herdrCommand(env);
	const paneId = env.HERDR_PANE_ID;
	if (!command || !paneId) return prompt();

	// The official Herdr Pi integration owns lifecycle authority. Notify it over
	// Pi's shared event bus; a separate CLI source cannot override its state.
	try {
		report?.(true, message);
	} catch {
		// Herdr reporting must never prevent the permission dialog.
	}

	const baseArgs = [paneId, "--source", SOURCE, "--agent", AGENT];
	try {
		await run(command, ["pane", "report-agent", ...baseArgs, "--state", "blocked", "--message", message]);
	} catch {
		// Keep the CLI path as a fallback for Herdr versions without the Pi
		// integration event listener.
	}

	try {
		return await prompt();
	} finally {
		try {
			report?.(false);
		} catch {
			// Keep the prompt result/error authoritative if cleanup cannot report.
		}
		try {
			await run(command, ["pane", "release-agent", ...baseArgs]);
		} catch {
			// Keep the prompt result/error authoritative if cleanup cannot report.
		}
	}
}
