import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "tool-guard-yolo";
export const YOLO_ENVIRONMENT_VARIABLE = "PI_TOOL_GUARD_YOLO";
export const YOLO_STATE_ENVIRONMENT_VARIABLE = "PI_TOOL_GUARD_YOLO_STATE";

function isEnvironmentEnabled(value: string | undefined): boolean {
	return ["1", "true", "yes", "on", "enabled"].includes(value?.trim().toLowerCase() ?? "");
}

export type YoloMode = {
	isEnabled: () => boolean;
};

export function registerYoloMode(pi: ExtensionAPI): YoloMode {
	let enabled = isEnvironmentEnabled(process.env[YOLO_ENVIRONMENT_VARIABLE]);
	let stateFile = process.env[YOLO_STATE_ENVIRONMENT_VARIABLE];
	const inherited = Boolean(stateFile);
	const isWorker = Number(process.env.PI_DELEGATE_WORKER_DEPTH ?? "0") > 0;
	let stateDirectory: string | undefined;

	const isEnabled = () => {
		if (!stateFile) return enabled;
		try {
			return readFileSync(stateFile, "utf8") === "1";
		} catch {
			// An unavailable shared state must not fall back to a stale inherited bypass.
			return false;
		}
	};
	const setEnabled = (value: boolean) => {
		if (!stateFile) {
			stateDirectory = mkdtempSync(join(tmpdir(), "pi-tool-guard-yolo-"));
			stateFile = join(stateDirectory, "state");
		}
		const pendingFile = `${stateFile}.pending`;
		writeFileSync(pendingFile, value ? "1" : "0", { mode: 0o600 });
		renameSync(pendingFile, stateFile);
		process.env[YOLO_STATE_ENVIRONMENT_VARIABLE] = stateFile;
		enabled = value;
		if (value) process.env[YOLO_ENVIRONMENT_VARIABLE] = "1";
		else delete process.env[YOLO_ENVIRONMENT_VARIABLE];
	};
	const updateStatus = (ctx: ExtensionContext) => {
		if (!isWorker) ctx.ui.setStatus(STATUS_ID, isEnabled() ? ctx.ui.theme.fg("warning", "YOLO") : undefined);
	};

	pi.registerCommand("yolo", {
		description: "Temporarily allow all tool-guard operations without confirmation",
		handler: async (_args, ctx) => {
			if (inherited) {
				ctx.ui.notify("YOLO mode is controlled by the parent pi session. Run /yolo there.", "info");
				return;
			}
			setEnabled(!isEnabled());
			updateStatus(ctx);
			ctx.ui.notify(`YOLO mode ${enabled ? "enabled" : "disabled"}.`, enabled ? "warning" : "info");
		},
	});

	pi.on("session_start", async (event, ctx) => {
		if (!inherited) setEnabled(event.reason === "startup" ? enabled : false);
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (inherited) return;
		enabled = false;
		if (stateDirectory) rmSync(stateDirectory, { recursive: true, force: true });
		if (process.env[YOLO_STATE_ENVIRONMENT_VARIABLE] === stateFile) delete process.env[YOLO_STATE_ENVIRONMENT_VARIABLE];
		delete process.env[YOLO_ENVIRONMENT_VARIABLE];
		stateDirectory = undefined;
		stateFile = undefined;
		updateStatus(ctx);
	});

	return { isEnabled };
}
