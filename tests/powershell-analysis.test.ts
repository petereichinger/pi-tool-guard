import assert from "node:assert/strict";
import test from "node:test";
import { analyzePowerShell } from "../extensions/tool-guard/powershell-analysis.ts";

test("PowerShell scripts are conservatively treated as potentially harmful", () => {
	const command = "Get-ChildItem; Remove-Item tmp -Recurse";
	const analysis = analyzePowerShell(command);

	assert.equal(analysis.parserAvailable, true);
	assert.deepEqual(analysis.commands, [
		{
			command,
			name: "powershell",
			harmless: false,
			reason: "PowerShell scripts require explicit approval",
		},
	]);
});

test("empty PowerShell scripts need no approval", () => {
	assert.deepEqual(analyzePowerShell("  \n"), { parserAvailable: true, commands: [] });
});
