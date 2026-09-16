import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "tool-guard-yolo";

export type YoloMode = {
	isEnabled: () => boolean;
};

function updateStatus(ctx: ExtensionContext, enabled: boolean): void {
	ctx.ui.setStatus(STATUS_ID, enabled ? ctx.ui.theme.fg("warning", "YOLO") : undefined);
}

export function registerYoloMode(pi: ExtensionAPI): YoloMode {
	let enabled = false;

	pi.registerCommand("yolo", {
		description: "Temporarily allow all tool-guard operations without confirmation",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			updateStatus(ctx, enabled);
			ctx.ui.notify(`YOLO mode ${enabled ? "enabled" : "disabled"}.`, enabled ? "warning" : "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		enabled = false;
		updateStatus(ctx, false);
	});

	return {
		isEnabled: () => enabled,
	};
}
