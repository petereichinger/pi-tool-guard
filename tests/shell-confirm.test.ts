import assert from "node:assert/strict";
import test from "node:test";
import { confirmShell } from "../extensions/tool-guard/bash-confirm.ts";
import { createPermissionRequestRunner } from "../extensions/tool-guard/permission-queue.ts";
import type { BashRule, LoadedConfigState } from "../extensions/tool-guard/types.ts";

const config = { allowRules: [], denyRules: [] } as unknown as LoadedConfigState;

test("PowerShell tool calls are blocked when approval UI is unavailable", async () => {
	const result = await confirmShell(
		{ hasUI: false },
		"powershell",
		"Get-ChildItem",
		[],
		[],
		config,
	);

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /PowerShell command blocked/);
});

test("PowerShell tool calls honor command allow rules", async () => {
	const allowRules: BashRule[] = [
		{ source: "^Get-ChildItem$", regex: /^Get-ChildItem$/, scope: "session", list: "allow" },
	];
	const result = await confirmShell(
		{ hasUI: false },
		"powershell",
		"Get-ChildItem",
		allowRules,
		[],
		config,
	);

	assert.equal(result, undefined);
});

test("queued permission requests recheck rules saved by an earlier agent", async () => {
	const allowRules: BashRule[] = [];
	const runPermissionRequest = createPermissionRequestRunner();
	const selections: string[] = [];
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		ui: {
			select: async (title: string) => {
				selections.push(title);
				if (title.startsWith("Allow bash command?")) return "Save allow rule…";
				if (title.startsWith("Save bash allow rule scope")) return "session";
				if (title.startsWith("Save bash allow rule mode")) return "Exact command";
				throw new Error(`Unexpected selection: ${title}`);
			},
			notify: () => {},
		},
	};

	const request = () => confirmShell(
		ctx,
		"bash",
		"npm install queued-package",
		allowRules,
		[],
		config,
		undefined,
		undefined,
		runPermissionRequest,
		async () => config,
	);
	const [first, second] = await Promise.all([request(), request()]);

	assert.equal(first, undefined);
	assert.equal(second, undefined);
	assert.equal(selections.filter((title) => title.startsWith("Allow bash command?")).length, 1);
	assert.equal(allowRules.length, 1);
});

test("a permission request reloads persistent rules before prompting", async () => {
	const refreshedConfig = {
		allowRules: [{ source: "^Get-Item$", regex: /^Get-Item$/, scope: "global", list: "allow" }],
		denyRules: [],
	} as unknown as LoadedConfigState;
	const result = await confirmShell(
		{ hasUI: true, ui: { select: () => { throw new Error("permission UI should not open"); } } },
		"powershell",
		"Get-Item",
		[],
		[],
		config,
		undefined,
		undefined,
		undefined,
		async () => refreshedConfig,
	);

	assert.equal(result, undefined);
});
