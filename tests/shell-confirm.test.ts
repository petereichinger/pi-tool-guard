import assert from "node:assert/strict";
import test from "node:test";
import { confirmShell } from "../extensions/tool-guard/bash-confirm.ts";
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
