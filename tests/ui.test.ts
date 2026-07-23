import assert from "node:assert/strict";
import test from "node:test";
import { editRegexRule, selectBashDecision } from "../extensions/tool-guard/ui.ts";

test("RPC regex editing uses prefilled editor content and keeps the command visible", async () => {
	const calls: unknown[][] = [];
	const ctx = {
		mode: "rpc",
		ui: {
			editor: async (...args: unknown[]) => {
				calls.push(args);
				return "edited";
			},
		},
	};

	const result = await editRegexRule(ctx, "Bash allow regex", "npm install foo", "^npm install foo$");

	assert.equal(result, "edited");
	assert.deepEqual(calls, [["Bash allow regex\n\nCommand: npm install foo", "^npm install foo$"]]);
});

test("RPC bash rule scope and mode dialogs repeat the current command", async () => {
	const requests: Array<{ title: string; options: string[] }> = [];
	const responses = ["Save allow rule…", "session", "Regex rule"];
	const ctx = {
		mode: "rpc",
		ui: {
			select: async (title: string, options: string[]) => {
				requests.push({ title, options });
				return responses.shift();
			},
		},
	};
	const command = "npm install foo";
	const evaluatedCommand = {
		index: 0,
		command,
		name: "npm",
		harmless: false,
		reason: "unknown command",
		allowedOnce: false,
	};

	const decision = await selectBashDecision(
		ctx,
		{ commands: [evaluatedCommand], pendingDangerous: [evaluatedCommand] },
		{ parserAvailable: true, commands: [evaluatedCommand] },
		0,
		{ repoLocation: undefined } as any,
	);

	assert.deepEqual(decision, { type: "save", scope: "session", mode: "regex" });
	assert.equal(requests.length, 3);
	assert.match(requests[0]!.title, /npm install foo/);
	assert.equal(requests[1]!.title, "Save bash allow rule scope\n\nCommand: npm install foo");
	assert.equal(requests[2]!.title, "Save bash allow rule mode\n\nCommand: npm install foo");
});
