import { execFile, spawn } from "node:child_process";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import { ghosttySurfaceId, isFocusedFromPids, niriWindowIdForPids, parseWindowsFocusSnapshot, powershellStringLiteral } from "./desktop-notify-utils.ts";
import { isTerminalFocused } from "./terminal-focus.ts";

const APP_NAME = "pi tool guard";
const ICON_PATH = fileURLToPath(new URL("./pi-favicon.svg", import.meta.url));
const MAX_BODY_LENGTH = 500;
let notificationSequence = 0;

type DesktopNotification = { dismiss: () => void };

function truncate(value: string) {
	return value.length <= MAX_BODY_LENGTH ? value : `${value.slice(0, MAX_BODY_LENGTH - 1)}…`;
}

function promptExcerpt(message: string) {
	const [heading = "Permission needed", ...commandLines] = message.split(/\r?\n/);
	return [heading, ...commandLines.slice(0, 2)].join("\n");
}

function run(command: string, args: string[]) {
	try {
		const child = spawn(command, args, {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.on("error", () => {});
		child.unref();
	} catch {
		// Desktop notifications are best-effort only.
	}
}

function runInTerminalSession(command: string, args: string[]) {
	try {
		const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
		child.on("error", () => {});
	} catch {
		// Terminal activation is best-effort only.
	}
}

function execText(command: string, args: string[], timeoutMs = 300): Promise<string | undefined> {
	return new Promise((resolve) => {
		try {
			const child = execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
				resolve(error ? undefined : stdout.trim());
			});
			child.on("error", () => resolve(undefined));
		} catch {
			resolve(undefined);
		}
	});
}

function appleScriptString(value: string) {
	return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

async function focusLinuxTerminal() {
	// Focus an exact terminal pane/tab first when the terminal exposes a stable ID.
	// Keep these children in pi's terminal session: kitty's CLI can use /dev/tty for
	// remote control when KITTY_LISTEN_ON is not configured.
	const kittyWindowId = process.env.KITTY_WINDOW_ID;
	if (kittyWindowId && /^\d+$/.test(kittyWindowId)) {
		runInTerminalSession("kitty", ["@", "focus-window", "--match", `id:${kittyWindowId}`, "--no-response"]);
	}
	const weztermPane = process.env.WEZTERM_PANE;
	if (weztermPane && /^\d+$/.test(weztermPane)) {
		runInTerminalSession("wezterm", ["cli", "activate-pane", "--pane-id", weztermPane]);
	}
	const ghosttySurface = ghosttySurfaceId(process.env.GHOSTTY_SURFACE_ID);
	if (ghosttySurface) {
		// Ghostty's GTK application exposes the same action used by its own
		// clickable terminal notifications. It raises the window and selects the
		// tab/split containing this exact surface.
		run("gdbus", [
			"call", "--session",
			"--dest", "com.mitchellh.ghostty",
			"--object-path", "/com/mitchellh/ghostty",
			"--method", "org.gtk.Actions.Activate",
			"present-surface", `[<uint64 ${ghosttySurface}>]`, "[]",
		]);
	}
	const tmuxPane = process.env.TMUX_PANE;
	if (tmuxPane && /^%\d+$/.test(tmuxPane)) {
		runInTerminalSession("tmux", ["select-pane", "-t", tmuxPane]);
	}

	const ancestors = await ancestorPids(process.pid);
	if (process.env.NIRI_SOCKET) {
		const windows = await execText("niri", ["msg", "-j", "windows"], 800);
		const windowId = niriWindowIdForPids(windows, ancestors);
		if (windowId) {
			run("niri", ["msg", "action", "focus-window", "--id", String(windowId)]);
			return;
		}
	}

	// WINDOWID is the most reliable generic X11 route. Exact pane/tab selection
	// above still improves this for multiplexing terminals such as kitty and tmux.
	const x11WindowId = process.env.WINDOWID;
	if (x11WindowId && /^(?:0x[\da-f]+|\d+)$/i.test(x11WindowId)) {
		run("xdotool", ["windowactivate", "--sync", x11WindowId]);
	}
}

function notifyLinux(title: string, body: string): DesktopNotification {
	let dismissed = false;
	let notificationId: string | undefined;
	let output = "";
	try {
		const child = spawn("notify-send", [
			"--print-id",
			"--action=default=Focus terminal",
			"--app-name", APP_NAME,
			"--icon", ICON_PATH,
			title,
			body,
		], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		child.on("error", () => {});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output += chunk;
			const lines = output.split(/\r?\n/);
			output = lines.pop() ?? "";
			for (const line of lines) {
				if (/^\d+$/.test(line)) {
					notificationId = line;
					if (dismissed) closeLinuxNotification(line);
				} else if (line === "default" && !dismissed) {
					void focusLinuxTerminal();
				}
			}
		});
	} catch {
		// Desktop notifications are best-effort only.
	}
	return {
		dismiss: () => {
			dismissed = true;
			if (notificationId) closeLinuxNotification(notificationId);
		},
	};
}

function closeLinuxNotification(notificationId: string) {
	run("gdbus", ["call", "--session", "--dest", "org.freedesktop.Notifications", "--object-path", "/org/freedesktop/Notifications", "--method", "org.freedesktop.Notifications.CloseNotification", notificationId]);
}

function notifyMac(title: string, body: string): DesktopNotification {
	run("osascript", ["-e", `display notification "${appleScriptString(body)}" with title "${appleScriptString(title)}"`]);
	// AppleScript's display notification API does not expose an identifier that can
	// be withdrawn. Keep the same lifecycle API for callers on macOS.
	return { dismiss: () => {} };
}

function notifyWindows(title: string, body: string): DesktopNotification {
	const tag = `guard-${process.pid}-${notificationSequence++}`;
	const script = `
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02
  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)
  $texts = $xml.GetElementsByTagName("text")
  $texts.Item(0).AppendChild($xml.CreateTextNode(${powershellStringLiteral(title)})) | Out-Null
  $texts.Item(1).AppendChild($xml.CreateTextNode(${powershellStringLiteral(body)})) | Out-Null
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  $toast.Tag = ${powershellStringLiteral(tag)}
  $toast.Group = ${powershellStringLiteral(APP_NAME)}
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${powershellStringLiteral(APP_NAME)})
  $notifier.Show($toast)
} catch {}
`;
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded]);
	return {
		dismiss: () => {
			const removeScript = `try { [Windows.UI.Notifications.ToastNotificationManager]::History.Remove(${powershellStringLiteral(tag)}, ${powershellStringLiteral(APP_NAME)}, ${powershellStringLiteral(APP_NAME)}) } catch {}`;
			const removeEncoded = Buffer.from(removeScript, "utf16le").toString("base64");
			run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", removeEncoded]);
		},
	};
}

async function parentPid(pid: number): Promise<number | undefined> {
	if (pid <= 1) return undefined;
	if (platform() === "win32") {
		const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).ParentProcessId`;
		const output = await execText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
		const parsed = Number(output);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
	}

	const output = await execText("ps", ["-o", "ppid=", "-p", String(pid)]);
	const parsed = Number(output?.trim());
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function ancestorPids(pid: number): Promise<Set<number>> {
	const ancestors = new Set<number>([pid]);
	let current: number | undefined = pid;
	for (let depth = 0; depth < 32 && current; depth += 1) {
		current = await parentPid(current);
		if (current) ancestors.add(current);
	}
	return ancestors;
}

async function linuxActiveWindowPid(): Promise<number | undefined> {
	const output = await execText("xdotool", ["getactivewindow", "getwindowpid"]);
	const parsed = Number(output);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function macActiveAppPid(): Promise<number | undefined> {
	const output = await execText("osascript", ["-e", "tell application \"System Events\" to unix id of first application process whose frontmost is true"]);
	const parsed = Number(output);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function windowsFocusSnapshot() {
	// Query both the foreground process and pi's complete ancestry in one
	// PowerShell process. Starting PowerShell once per ancestor is slow enough to
	// exceed the old 300 ms timeout on many Windows systems.
	const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Focus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$foregroundPid = 0
[Win32Focus]::GetWindowThreadProcessId([Win32Focus]::GetForegroundWindow(), [ref]$foregroundPid) | Out-Null
$ancestorPids = @()
$currentPid = [uint32]${process.pid}
for ($depth = 0; $depth -lt 32 -and $currentPid -gt 0; $depth++) {
  $ancestorPids += $currentPid
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$currentPid" -ErrorAction SilentlyContinue
  if ($null -eq $processInfo) { break }
  $parentPid = [uint32]$processInfo.ParentProcessId
  if ($parentPid -eq 0 -or $parentPid -eq $currentPid) { break }
  $currentPid = $parentPid
}
[pscustomobject]@{
  foregroundPid = [uint32]$foregroundPid
  ancestorPids = @($ancestorPids)
} | ConvertTo-Json -Compress
`;
	const output = await execText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 1500);
	return parseWindowsFocusSnapshot(output);
}

async function activeWindowPid(): Promise<number | undefined> {
	const os = platform();
	if (os === "linux") return linuxActiveWindowPid();
	if (os === "darwin") return macActiveAppPid();
	return undefined;
}

async function isLikelyFocused(): Promise<boolean | undefined> {
	const terminalFocused = isTerminalFocused();
	if (terminalFocused !== undefined) return terminalFocused;

	if (platform() === "win32") {
		const snapshot = await windowsFocusSnapshot();
		return snapshot ? snapshot.ancestorPids.has(snapshot.foregroundPid) : undefined;
	}

	const activePid = await activeWindowPid();
	if (!activePid) return undefined;
	const ancestors = await ancestorPids(process.pid);
	return isFocusedFromPids(activePid, ancestors);
}

export function notifyDesktop(title: string, body: string): DesktopNotification {
	const safeTitle = truncate(title);
	const safeBody = truncate(body);
	const os = platform();
	if (os === "linux") return notifyLinux(safeTitle, safeBody);
	if (os === "darwin") return notifyMac(safeTitle, safeBody);
	if (os === "win32") return notifyWindows(safeTitle, safeBody);
	return { dismiss: () => {} };
}

export function notifyGuardPrompt(message: string): DesktopNotification {
	let dismissed = false;
	let notification: DesktopNotification | undefined;
	void (async () => {
		// Only notify when pi's terminal is likely not focused. If focus detection is
		// unavailable (for example Wayland without xdotool), notify anyway.
		if (await isLikelyFocused() || dismissed) return;
		notification = notifyDesktop(APP_NAME, promptExcerpt(message));
		if (dismissed) notification.dismiss();
	})();
	return {
		dismiss: () => {
			dismissed = true;
			notification?.dismiss();
		},
	};
}
