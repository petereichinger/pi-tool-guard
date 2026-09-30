import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import toolGuard from "../extensions/tool-guard/main.ts";
import {
	registerYoloMode,
	YOLO_ENVIRONMENT_VARIABLE,
	YOLO_STATE_ENVIRONMENT_VARIABLE,
} from "../extensions/tool-guard/yolo-mode.ts";

const environmentKeys = [YOLO_ENVIRONMENT_VARIABLE, YOLO_STATE_ENVIRONMENT_VARIABLE, "PI_DELEGATE_WORKER_DEPTH", "PI_CODING_AGENT_DIR"];

function isolate(t: TestContext) {
	const saved = environmentKeys.map((key) => [key, process.env[key]] as const);
	const cleanup: Array<() => void | Promise<void>> = [];
	for (const key of environmentKeys) delete process.env[key];
	t.after(async () => {
		const errors: unknown[] = [];
		try {
			for (const action of cleanup.reverse()) {
				try {
					await action();
				} catch (error) {
					errors.push(error);
				}
			}
		} finally {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
		if (errors.length) throw new AggregateError(errors, "YOLO test cleanup failed");
	});
	return {
		cleanup,
		temporaryDirectory() {
			const directory = mkdtempSync(join(tmpdir(), "pi-tool-guard-yolo-test-"));
			cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
			return directory;
		},
	};
}

function createRuntime(scope: ReturnType<typeof isolate>, extension = registerYoloMode) {
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<any>>>();
	const statuses: Array<{ id: string; value: string | undefined }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const entries: unknown[] = [];
	const pi = {
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on(name: string, handler: (event: any, ctx: any) => Promise<any>) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		events: { emit: () => {} },
		appendEntry: (...args: unknown[]) => entries.push(args),
	};
	const ctx = {
		ui: {
			theme: { fg: (_color: string, text: string) => `[warning]${text}` },
			setStatus: (id: string, value: string | undefined) => statuses.push({ id, value }),
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
	};
	const mode = extension(pi as any);
	const lifecycle = async (name: string, event = {}) => {
		const handler = handlers.get(name)?.[0];
		assert.ok(handler, `Missing ${name} handler`);
		await handler(event, ctx);
	};
	scope.cleanup.push(() => lifecycle("session_shutdown"));
	return {
		mode, ctx, handlers, statuses, notifications, entries,
		start: (reason = "startup") => lifecycle("session_start", { reason }),
		shutdown: () => lifecycle("session_shutdown"),
		toggle: () => commands.get("yolo").handler("", ctx),
	};
}

function sharedFile() {
	const path = process.env[YOLO_STATE_ENVIRONMENT_VARIABLE];
	assert.ok(path, "Startup must publish the shared state path");
	return path;
}

function receive(child: ChildProcess, type: string, id?: number): Promise<any> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error(`Timed out waiting for worker ${type}`)), 10_000);
		const onMessage = (message: any) => {
			if (message.type === type && (id === undefined || message.id === id)) {
				finish(message.error ? new Error(message.error) : undefined, message.result);
			}
		};
		const onError = (error: Error) => finish(error);
		const onExit = (code: number | null) => finish(new Error(`Worker exited (${code}) before ${type}`));
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

async function spawnWorker(scope: ReturnType<typeof isolate>) {
	const child = fork(new URL("./fixtures/yolo-worker.ts", import.meta.url), [], {
		env: { ...process.env, PI_DELEGATE_WORKER_DEPTH: "1", PI_CODING_AGENT_DIR: scope.temporaryDirectory() },
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	scope.cleanup.push(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill();
		await exited;
	});
	let sequence = 0;
	return {
		ready: await receive(child, "ready"),
		exited,
		async request(action: string, nestedAction?: string) {
			const id = ++sequence;
			const response = receive(child, "response", id);
			child.send({ id, action, nestedAction });
			return response;
		},
	};
}

function assertWorker(snapshot: any, enabled: boolean, path: string, depth: number) {
	assert.equal(snapshot.enabled, enabled);
	assert.equal(snapshot.stateFile, path);
	assert.equal(snapshot.depth, depth);
	assert.deepEqual(snapshot.statuses, [], "Workers must not add a YOLO footer status");
	assert.deepEqual(snapshot.entries, [], "YOLO state must not be persisted to session entries");
}

test("startup creates disabled shared state, toggles status, and shutdown removes owned state", async (t) => {
	const runtime = createRuntime(isolate(t));
	assert.equal(runtime.mode.isEnabled(), false);
	await runtime.start();
	const path = sharedFile();
	assert.equal(readFileSync(path, "utf8"), "0");
	assert.equal(process.env[YOLO_ENVIRONMENT_VARIABLE], undefined);
	assert.deepEqual(runtime.statuses.at(-1), { id: "tool-guard-yolo", value: undefined });

	await runtime.toggle();
	assert.equal(runtime.mode.isEnabled(), true);
	assert.equal(readFileSync(path, "utf8"), "1");
	assert.equal(process.env[YOLO_ENVIRONMENT_VARIABLE], "1");
	assert.deepEqual(runtime.statuses.at(-1), { id: "tool-guard-yolo", value: "[warning]YOLO" });
	assert.deepEqual(runtime.notifications.at(-1), { message: "YOLO mode enabled.", level: "warning" });

	await runtime.toggle();
	assert.equal(runtime.mode.isEnabled(), false);
	assert.equal(readFileSync(path, "utf8"), "0");
	assert.equal(process.env[YOLO_ENVIRONMENT_VARIABLE], undefined);
	assert.deepEqual(runtime.statuses.at(-1), { id: "tool-guard-yolo", value: undefined });
	assert.deepEqual(runtime.notifications.at(-1), { message: "YOLO mode disabled.", level: "info" });

	await runtime.toggle();
	await runtime.shutdown();
	assert.equal(runtime.mode.isEnabled(), false);
	assert.equal(existsSync(dirname(path)), false);
	assert.equal(process.env[YOLO_STATE_ENVIRONMENT_VARIABLE], undefined);
	assert.equal(process.env[YOLO_ENVIRONMENT_VARIABLE], undefined);
	assert.deepEqual(runtime.statuses.at(-1), { id: "tool-guard-yolo", value: undefined });
	assert.deepEqual(runtime.entries, []);
});

for (const reason of ["new", "resume", "reload", "fork"]) {
	test(`session ${reason} resets YOLO without persisting or replacing the shared path`, async (t) => {
		const runtime = createRuntime(isolate(t));
		await runtime.start();
		const path = sharedFile();
		await runtime.toggle();
		await runtime.start(reason);
		assert.equal(runtime.mode.isEnabled(), false);
		assert.equal(sharedFile(), path);
		assert.equal(readFileSync(path, "utf8"), "0");
		assert.equal(process.env[YOLO_ENVIRONMENT_VARIABLE], undefined);
		assert.deepEqual(runtime.entries, []);
	});
}

for (const value of ["1", "true", "yes", "on", "enabled", " TRUE ", "0", "false", "invalid"]) {
	test(`legacy environment startup handles ${JSON.stringify(value)}`, async (t) => {
		const scope = isolate(t);
		process.env[YOLO_ENVIRONMENT_VARIABLE] = value;
		const runtime = createRuntime(scope);
		const enabled = !["0", "false", "invalid"].includes(value);
		await runtime.start();
		const path = sharedFile();
		assert.equal(runtime.mode.isEnabled(), enabled);
		assert.equal(readFileSync(path, "utf8"), enabled ? "1" : "0");
		assert.equal(process.env[YOLO_ENVIRONMENT_VARIABLE], enabled ? "1" : undefined);
		assert.equal(runtime.statuses.at(-1)?.value, enabled ? "[warning]YOLO" : undefined);
		await runtime.shutdown();
		assert.equal(runtime.mode.isEnabled(), false);
		assert.equal(existsSync(dirname(path)), false);
		assert.equal(process.env[YOLO_ENVIRONMENT_VARIABLE], undefined);
		assert.equal(process.env[YOLO_STATE_ENVIRONMENT_VARIABLE], undefined);
		assert.deepEqual(runtime.entries, []);
	});
}

test("already-running child and nested workers follow parent toggles from disabled state", { timeout: 30_000 }, async (t) => {
	const scope = isolate(t);
	const runtime = createRuntime(scope);
	await runtime.start();
	const path = sharedFile();
	const worker = await spawnWorker(scope);
	assertWorker(worker.ready, false, path, 1);
	assert.equal(worker.ready.legacy, undefined);
	assertWorker(await worker.request("spawn"), false, path, 2);
	assert.deepEqual(await worker.request("tools"), [true, true, true, true]);
	assert.deepEqual(await worker.request("nested", "tools"), [true, true, true, true]);

	for (const enabled of [true, false, true]) {
		await runtime.toggle();
		assertWorker(await worker.request("snapshot"), enabled, path, 1);
		assertWorker(await worker.request("nested", "snapshot"), enabled, path, 2);
		assert.deepEqual(await worker.request("tools"), Array(4).fill(!enabled));
		assert.deepEqual(await worker.request("nested", "tools"), Array(4).fill(!enabled));
	}
	for (const target of ["toggle", "nested"]) {
		const snapshot = await worker.request(target, target === "nested" ? "toggle" : undefined);
		assertWorker(snapshot, true, path, target === "nested" ? 2 : 1);
		assert.deepEqual(snapshot.notifications.at(-1), {
			message: "YOLO mode is controlled by the parent pi session. Run /yolo there.", level: "info",
		});
		assert.equal(runtime.mode.isEnabled(), true);
		assert.equal(readFileSync(path, "utf8"), "1");
	}

	assertWorker(await worker.request("nested", "shutdown"), true, path, 2);
	assert.equal(runtime.mode.isEnabled(), true);
	assert.equal(readFileSync(path, "utf8"), "1");
	assertWorker(await worker.request("shutdown"), true, path, 1);
	await worker.exited;
	assert.equal(runtime.mode.isEnabled(), true);
	assert.equal(process.env[YOLO_ENVIRONMENT_VARIABLE], "1");
	assert.equal(sharedFile(), path);
	assert.equal(readFileSync(path, "utf8"), "1");
	await runtime.shutdown();
	assert.equal(existsSync(dirname(path)), false);
	assert.deepEqual(runtime.entries, []);
});

test("live workers fail closed when shared state is corrupt or removed despite inherited legacy bypass", { timeout: 30_000 }, async (t) => {
	const scope = isolate(t);
	const runtime = createRuntime(scope);
	await runtime.start();
	await runtime.toggle();
	const path = sharedFile();
	const worker = await spawnWorker(scope);
	assertWorker(worker.ready, true, path, 1);
	assert.equal(worker.ready.legacy, "1");
	assertWorker(await worker.request("spawn"), true, path, 2);

	for (const content of ["", "true", "1\n", "garbage", "0"]) {
		writeFileSync(path, content);
		assert.equal(runtime.mode.isEnabled(), false);
		assertWorker(await worker.request("snapshot"), false, path, 1);
		assertWorker(await worker.request("nested", "snapshot"), false, path, 2);
	}
	rmSync(path);
	assert.equal(runtime.mode.isEnabled(), false);
	const missing = await worker.request("snapshot");
	assertWorker(missing, false, path, 1);
	assert.equal(missing.legacy, "1");
	assertWorker(await worker.request("nested", "snapshot"), false, path, 2);
	await runtime.toggle();
	assertWorker(await worker.request("snapshot"), true, path, 1);
	assertWorker(await worker.request("nested", "snapshot"), true, path, 2);
	await runtime.shutdown();
	assert.equal(existsSync(dirname(path)), false);
	assertWorker(await worker.request("snapshot"), false, path, 1);
	assertWorker(await worker.request("nested", "snapshot"), false, path, 2);
	await worker.request("nested", "shutdown");
	await worker.request("shutdown");
	await worker.exited;
});

for (const content of [undefined, "corrupt"]) {
	test(`inherited ${content === undefined ? "missing" : "corrupt"} state fails closed at startup and is not owned`, async (t) => {
		const scope = isolate(t);
		const directory = scope.temporaryDirectory();
		const path = join(directory, "state");
		if (content !== undefined) writeFileSync(path, content);
		process.env[YOLO_STATE_ENVIRONMENT_VARIABLE] = path;
		process.env[YOLO_ENVIRONMENT_VARIABLE] = "1";
		process.env.PI_DELEGATE_WORKER_DEPTH = "1";
		const runtime = createRuntime(scope);
		assert.equal(runtime.mode.isEnabled(), false);
		await runtime.start();
		await runtime.toggle();
		await runtime.shutdown();
		assert.equal(runtime.mode.isEnabled(), false);
		assert.equal(existsSync(directory), true);
		assert.equal(existsSync(path), content !== undefined);
		if (content !== undefined) assert.equal(readFileSync(path, "utf8"), content);
		assert.equal(sharedFile(), path);
		assert.equal(process.env[YOLO_ENVIRONMENT_VARIABLE], "1");
		assert.deepEqual(runtime.statuses, []);
		assert.deepEqual(runtime.entries, []);
	});
}

test("file requests recheck YOLO while an earlier approval is open", { timeout: 10_000 }, async (t) => {
	const scope = isolate(t);
	process.env.PI_CODING_AGENT_DIR = scope.temporaryDirectory();
	const runtime = createRuntime(scope, toolGuard as any);
	const ctx = Object.assign(runtime.ctx, { cwd: scope.temporaryDirectory(), hasUI: true });
	const target = join(scope.temporaryDirectory(), "outside-file");
	let showPrompt!: () => void;
	const prompted = new Promise<void>((resolve) => { showPrompt = resolve; });
	let answerPrompt!: (value: string) => void;
	const answer = new Promise<string>((resolve) => { answerPrompt = resolve; });
	let prompts = 0;
	Object.assign(ctx.ui, {
		select: async () => { prompts++; showPrompt(); return answer; },
	});
	const toolCall = runtime.handlers.get("tool_call")![0];
	const first = toolCall({ toolName: "write", input: { path: target } }, ctx);
	await prompted;
	const second = toolCall({ toolName: "edit", input: { path: target } }, ctx);
	await runtime.toggle();
	answerPrompt("Deny");
	assert.equal((await first)?.block, true);
	assert.equal(await second, undefined);
	assert.equal(prompts, 1);
});

test("tool-guard bypasses shell and file mutation checks while yolo mode is enabled", async (t) => {
	const runtime = createRuntime(isolate(t), toolGuard as any);
	await runtime.toggle();
	const toolCall = runtime.handlers.get("tool_call")?.[0];
	assert.ok(toolCall);
	for (const event of [
		{ toolName: "bash", input: { command: "rm -rf /" } },
		{ toolName: "powershell", input: { command: "Remove-Item -Recurse C:/outside" } },
		{ toolName: "edit", input: { path: "C:/outside/file" } },
		{ toolName: "write", input: { path: "C:/outside/file", content: "test" } },
	]) {
		assert.equal(await toolCall(event, runtime.ctx), undefined);
	}
	assert.deepEqual(runtime.entries, []);
});
