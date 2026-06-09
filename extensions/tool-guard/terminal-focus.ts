let terminalFocused: boolean | undefined;
let initialized = false;

function isKittySession() {
	return !!process.env.KITTY_WINDOW_ID || (process.env.TERM ?? "").toLowerCase().includes("kitty");
}

function enableFocusEvents() {
	try {
		if (!process.stdout.isTTY) return;
		process.stdout.write("\x1b[?1004h");
		process.once("exit", () => {
			try {
				process.stdout.write("\x1b[?1004l");
			} catch {}
		});
	} catch {
		// Focus tracking is best-effort only.
	}
}

export function setupTerminalFocusTracking(ctx: any) {
	if (initialized) return;
	initialized = true;

	// Kitty supports focus in/out events. Assume the terminal is initially focused
	// when pi starts; a FocusOut event will flip this when the user switches away.
	if (isKittySession()) terminalFocused = true;

	enableFocusEvents();

	try {
		ctx.ui.onTerminalInput((data: string) => {
			if (data.includes("\x1b[I")) terminalFocused = true;
			else if (data.includes("\x1b[O")) terminalFocused = false;
		});
	} catch {
		// Some UI modes do not expose terminal input.
	}
}

export function isTerminalFocused() {
	return terminalFocused;
}
