import assert from "node:assert/strict";
import test from "node:test";
import toolGuard from "../extensions/tool-guard/main.ts";
import { registerYoloMode, YOLO_ENVIRONMENT_VARIABLE } from "../extensions/tool-guard/yolo-mode.ts";

test("the yolo command toggles temporary bypass state and footer status", async () => {
	delete process.env[YOLO_ENVIRONMENT_VARIABLE];
	const commands = new Map<string, any>();
	const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
	const statuses: Array<string | undefined> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const pi = {
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		on(name: string, handler: (event: any, ctx: any) => Promise<void>) {
			handlers.set(name, handler);
		},
	};
	const ctx = {
		ui: {
			theme: { fg: (_color: string, text: string) => `[warning]${text}` },
			setStatus: (_id: string, value: string | undefined) => statuses.push(value),
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
	};
	const yoloMode = registerYoloMode(pi as any);
	const command = commands.get("yolo");

	assert.ok(command);
	assert.equal(yoloMode.isEnabled(), false);

	await command.handler("", ctx);
	assert.equal(yoloMode.isEnabled(), true);
	assert.equal(process.env[YOLO_ENVIRONMENT_VARIABLE], "1");
	assert.equal(statuses.at(-1), "[warning]YOLO");
	assert.deepEqual(notifications.at(-1), { message: "YOLO mode enabled.", level: "warning" });

	await command.handler("", ctx);
	assert.equal(yoloMode.isEnabled(), false);
	assert.equal(process.env[YOLO_ENVIRONMENT_VARIABLE], undefined);
	assert.equal(statuses.at(-1), undefined);
	assert.deepEqual(notifications.at(-1), { message: "YOLO mode disabled.", level: "info" });

	await command.handler("", ctx);
	await handlers.get("session_start")?.({}, ctx);
	assert.equal(yoloMode.isEnabled(), false);
	assert.equal(process.env[YOLO_ENVIRONMENT_VARIABLE], undefined);
	assert.equal(statuses.at(-1), undefined);
});

test("an inherited yolo environment enables a newly spawned pi runtime", async () => {
	process.env[YOLO_ENVIRONMENT_VARIABLE] = "1";
	const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
	const statuses: Array<string | undefined> = [];
	const pi = {
		registerCommand: () => {},
		on(name: string, handler: (event: any, ctx: any) => Promise<void>) {
			handlers.set(name, handler);
		},
	};
	const ctx = {
		ui: {
			theme: { fg: (_color: string, text: string) => `[warning]${text}` },
			setStatus: (_id: string, value: string | undefined) => statuses.push(value),
		},
	};
	const yoloMode = registerYoloMode(pi as any);

	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	assert.equal(yoloMode.isEnabled(), true);
	assert.equal(statuses.at(-1), "[warning]YOLO");

	await handlers.get("session_shutdown")?.({}, ctx);
	assert.equal(yoloMode.isEnabled(), false);
	assert.equal(process.env[YOLO_ENVIRONMENT_VARIABLE], undefined);
});

test("tool-guard bypasses shell and file mutation checks while yolo mode is enabled", async () => {
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<any>>>();
	const pi = {
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		on(name: string, handler: (event: any, ctx: any) => Promise<any>) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		events: { emit: () => {} },
		appendEntry: () => {},
	};
	const ctx = {
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: () => {},
			notify: () => {},
		},
	};

	toolGuard(pi as any);
	await commands.get("yolo").handler("", ctx);
	const toolCall = handlers.get("tool_call")?.[0];

	assert.ok(toolCall);
	assert.equal(await toolCall({ toolName: "bash", input: { command: "rm -rf /" } }, ctx), undefined);
	assert.equal(await toolCall({ toolName: "edit", input: { path: "C:/outside/file" } }, ctx), undefined);
});
