import assert from "node:assert/strict";
import test from "node:test";
import { registerHerdrPromptBridge } from "../extensions/tool-guard/main.ts";

test("bridges pi prompt lifecycle events to the Herdr agent-state integration", () => {
	const handlers = new Map<string, (event?: any) => void>();
	const emitted: Array<{ name: string; data: any }> = [];
	const pi = {
		on(name: string, handler: (event?: any) => void) {
			handlers.set(name, handler);
		},
		events: {
			emit(name: string, data: any) {
				emitted.push({ name, data });
			},
		},
	};

	registerHerdrPromptBridge(pi as any);
	handlers.get("ui_prompt_start")?.({ title: "Allow bash command?" });
	handlers.get("ui_prompt_end")?.();

	assert.deepEqual(emitted, [
		{ name: "herdr:blocked", data: { active: true, label: "Allow bash command?" } },
		{ name: "herdr:blocked", data: { active: false } },
	]);
});
