import { fork, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import toolGuard from "../../extensions/tool-guard/main.ts";
import { registerYoloMode } from "../../extensions/tool-guard/yolo-mode.ts";

const commands = new Map<string, any>();
const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
const statuses: Array<string | undefined> = [];
const notifications: Array<{ message: string; level: string }> = [];
const entries: unknown[] = [];
const ctx = {
	cwd: process.cwd(),
	hasUI: false,
	ui: {
		theme: { fg: (_color: string, text: string) => `[warning]${text}` },
		setStatus: (_id: string, value: string | undefined) => statuses.push(value),
		notify: (message: string, level: string) => notifications.push({ message, level }),
	},
};
const mode = registerYoloMode({
	registerCommand: (name: string, command: any) => commands.set(name, command),
	on: (name: string, handler: any) => handlers.set(name, handler),
	appendEntry: (...args: unknown[]) => entries.push(args),
} as any);

let guardToolCall: (event: any, ctx: any) => Promise<any>;
toolGuard({
	registerCommand: () => {},
	on(name: string, handler: any) {
		if (name === "tool_call") guardToolCall = handler;
	},
	events: { emit: () => {} },
	appendEntry: (...args: unknown[]) => entries.push(args),
} as any);

function snapshot() {
	return {
		enabled: mode.isEnabled(),
		statuses,
		notifications,
		entries,
		stateFile: process.env.PI_TOOL_GUARD_YOLO_STATE,
		legacy: process.env.PI_TOOL_GUARD_YOLO,
		depth: Number(process.env.PI_DELEGATE_WORKER_DEPTH),
	};
}

let nested: ChildProcess | undefined;
let sequence = 0;
function receive(child: ChildProcess, type: string, id?: number): Promise<any> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${type}`)), 10_000);
		const onMessage = (message: any) => {
			if (message.type === type && (id === undefined || message.id === id)) {
				finish(message.error ? new Error(message.error) : undefined, message.result);
			}
		};
		const onError = (error: Error) => finish(error);
		const onExit = () => finish(new Error(`Nested worker exited before ${type}`));
		function finish(error?: Error, result?: any) {
			clearTimeout(timer);
			child.off("message", onMessage);
			child.off("error", onError);
			child.off("exit", onExit);
			if (error) reject(error);
			else resolve(result);
		}
		child.on("message", onMessage);
		child.on("error", onError);
		child.on("exit", onExit);
	});
}

process.on("disconnect", () => {
	nested?.kill();
});
process.on("message", async (message: any) => {
	try {
		let result: any;
		switch (message.action) {
			case "snapshot":
				result = snapshot();
				break;
			case "tools": {
				const blocked: boolean[] = [];
				for (const event of [
					{ toolName: "bash", input: { command: "guard-yolo-probe-command" } },
					{ toolName: "powershell", input: { command: "guard-yolo-probe-command" } },
					{ toolName: "write", input: { path: join(tmpdir(), "guard-yolo-probe-file"), content: "test" } },
					{ toolName: "edit", input: { path: join(tmpdir(), "guard-yolo-probe-file") } },
				]) {
					blocked.push((await guardToolCall(event, ctx))?.block === true);
				}
				result = blocked;
				break;
			}
			case "toggle":
				await commands.get("yolo").handler("", ctx);
				result = snapshot();
				break;
			case "spawn":
				if (nested) throw new Error("Nested worker already exists");
				nested = fork(new URL(import.meta.url), [], {
					env: { ...process.env, PI_DELEGATE_WORKER_DEPTH: String(Number(process.env.PI_DELEGATE_WORKER_DEPTH) + 1) },
					stdio: ["ignore", "ignore", "inherit", "ipc"],
				});
				result = await receive(nested, "ready");
				break;
			case "nested": {
				if (!nested) throw new Error("No nested worker");
				const id = ++sequence;
				const response = receive(nested, "response", id);
				nested.send({ id, action: message.nestedAction });
				result = await response;
				break;
			}
			case "shutdown":
				await handlers.get("session_shutdown")!({}, ctx);
				result = snapshot();
				break;
			default:
				throw new Error(`Unknown action: ${message.action}`);
		}
		process.send!({ type: "response", id: message.id, result }, () => {
			if (message.action === "shutdown") process.disconnect();
		});
	} catch (error) {
		process.send!({ type: "response", id: message.id, error: String(error) });
	}
});

await handlers.get("session_start")!({ reason: "startup" }, ctx);
process.send!({ type: "ready", result: snapshot() });
