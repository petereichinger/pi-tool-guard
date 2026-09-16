import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "tool-guard-yolo";
export const YOLO_ENVIRONMENT_VARIABLE = "PI_TOOL_GUARD_YOLO";

function isEnvironmentEnabled(value: string | undefined): boolean {
	return ["1", "true", "yes", "on", "enabled"].includes(value?.trim().toLowerCase() ?? "");
}

export type YoloMode = {
	isEnabled: () => boolean;
};

function updateStatus(ctx: ExtensionContext, enabled: boolean): void {
	ctx.ui.setStatus(STATUS_ID, enabled ? ctx.ui.theme.fg("warning", "YOLO") : undefined);
}

export function registerYoloMode(pi: ExtensionAPI): YoloMode {
	let enabled = isEnvironmentEnabled(process.env[YOLO_ENVIRONMENT_VARIABLE]);
	const setEnabled = (value: boolean) => {
		enabled = value;
		if (value) process.env[YOLO_ENVIRONMENT_VARIABLE] = "1";
		else delete process.env[YOLO_ENVIRONMENT_VARIABLE];
	};

	pi.registerCommand("yolo", {
		description: "Temporarily allow all tool-guard operations without confirmation",
		handler: async (_args, ctx) => {
			setEnabled(!enabled);
			updateStatus(ctx, enabled);
			ctx.ui.notify(`YOLO mode ${enabled ? "enabled" : "disabled"}.`, enabled ? "warning" : "info");
		},
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup") setEnabled(false);
		updateStatus(ctx, enabled);
	});

	pi.on("session_shutdown", async () => {
		setEnabled(false);
	});

	return {
		isEnabled: () => enabled,
	};
}
