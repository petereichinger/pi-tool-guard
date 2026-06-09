import { execFile, spawn } from "node:child_process";
import { platform } from "node:os";
import { isTerminalFocused } from "./terminal-focus.ts";

const APP_NAME = "pi tool guard";
const MAX_BODY_LENGTH = 500;

function truncate(value: string) {
	return value.length <= MAX_BODY_LENGTH ? value : `${value.slice(0, MAX_BODY_LENGTH - 1)}…`;
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

function notifyLinux(title: string, body: string) {
	run("notify-send", [title, body]);
}

function notifyMac(title: string, body: string) {
	run("osascript", ["-e", `display notification "${appleScriptString(body)}" with title "${appleScriptString(title)}"`]);
}

function notifyWindows(title: string, body: string) {
	const script = `
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02
  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)
  $texts = $xml.GetElementsByTagName("text")
  $texts.Item(0).AppendChild($xml.CreateTextNode(${JSON.stringify(title)})) | Out-Null
  $texts.Item(1).AppendChild($xml.CreateTextNode(${JSON.stringify(body)})) | Out-Null
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${JSON.stringify(APP_NAME)})
  $notifier.Show($toast)
} catch {}
`;
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded]);
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

async function windowsForegroundWindowPid(): Promise<number | undefined> {
	const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Focus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$pidOut = 0
[Win32Focus]::GetWindowThreadProcessId([Win32Focus]::GetForegroundWindow(), [ref]$pidOut) | Out-Null
$pidOut
`;
	const output = await execText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
	const parsed = Number(output);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function activeWindowPid(): Promise<number | undefined> {
	const os = platform();
	if (os === "linux") return linuxActiveWindowPid();
	if (os === "darwin") return macActiveAppPid();
	if (os === "win32") return windowsForegroundWindowPid();
	return undefined;
}

async function isLikelyFocused(): Promise<boolean | undefined> {
	const terminalFocused = isTerminalFocused();
	if (terminalFocused !== undefined) return terminalFocused;

	const activePid = await activeWindowPid();
	if (!activePid) return undefined;
	const ancestors = await ancestorPids(process.pid);
	return ancestors.has(activePid);
}

export function notifyDesktop(title: string, body: string) {
	const safeTitle = truncate(title);
	const safeBody = truncate(body);
	const os = platform();
	if (os === "linux") return notifyLinux(safeTitle, safeBody);
	if (os === "darwin") return notifyMac(safeTitle, safeBody);
	if (os === "win32") return notifyWindows(safeTitle, safeBody);
}

export function notifyGuardPrompt(message: string) {
	void (async () => {
		// Only notify when pi's terminal is likely not focused. If focus detection is
		// unavailable (for example Wayland without xdotool), notify anyway.
		if (await isLikelyFocused()) return;
		notifyDesktop(APP_NAME, message);
	})();
}
