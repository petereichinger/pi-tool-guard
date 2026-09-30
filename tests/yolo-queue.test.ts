import assert from "node:assert/strict";
import test from "node:test";
import { confirmShell } from "../extensions/tool-guard/bash-confirm.ts";
import type { PermissionRequestRunner } from "../extensions/tool-guard/permission-queue.ts";
import type { LoadedConfigState } from "../extensions/tool-guard/types.ts";

const config = { allowRules: [], denyRules: [] } as unknown as LoadedConfigState;

for (const shell of ["bash", "powershell"] as const) {
	test(`queued ${shell} permission requests recheck YOLO before rules and approval`, async () => {
		let bypassed = false;
		let reloads = 0;
		const runPermissionRequest: PermissionRequestRunner = async (request) => {
			bypassed = true;
			return request();
		};
		const result = await confirmShell(
			{ cwd: process.cwd(), hasUI: false },
			shell,
			"remove-pending-files",
			[],
			[{ source: ".*", regex: /.*/, scope: "session", list: "deny" }],
			config,
			undefined,
			runPermissionRequest,
			async () => { reloads++; return config; },
			() => bypassed,
		);
		assert.equal(result, undefined);
		assert.equal(reloads, 0);
	});
}

test("shell requests recheck YOLO after asynchronous config loading", async () => {
	let bypassed = false;
	const result = await confirmShell(
		{ hasUI: false },
		"powershell",
		"Remove-Item pending-file",
		[],
		[],
		config,
		undefined,
		undefined,
		async () => { bypassed = true; return config; },
		() => bypassed,
	);
	assert.equal(result, undefined);
});
