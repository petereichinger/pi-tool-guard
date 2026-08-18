import assert from "node:assert/strict";
import test from "node:test";
import { withHerdrInputStatus } from "../extensions/tool-guard/herdr-status.ts";

test("reports a tool-guard dialog as blocked and releases it after input", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const result = await withHerdrInputStatus(
		async () => "allowed",
		"Waiting for approval",
		{ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: "/usr/bin/herdr" },
		async (command, args) => { calls.push({ command, args }); },
	);

	assert.equal(result, "allowed");
	assert.deepEqual(calls, [
		{
			command: "/usr/bin/herdr",
			args: ["pane", "report-agent", "w1:p1", "--source", "custom:pi-tool-guard", "--agent", "pi", "--state", "blocked", "--message", "Waiting for approval"],
		},
		{
			command: "/usr/bin/herdr",
			args: ["pane", "release-agent", "w1:p1", "--source", "custom:pi-tool-guard", "--agent", "pi"],
		},
	]);
});

test("releases Herdr state even when the dialog is cancelled or fails", async () => {
	const calls: string[][] = [];
	await assert.rejects(() => withHerdrInputStatus(
		async () => { throw new Error("cancelled"); },
		undefined,
		{ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
		async (_command, args) => { calls.push(args); },
	));
	assert.equal(calls[1]?.[1], "release-agent");
});

test("does nothing outside a Herdr pane", async () => {
	let reported = false;
	const result = await withHerdrInputStatus(
		async () => "allowed",
		undefined,
		{},
		async () => { reported = true; },
	);
	assert.equal(result, "allowed");
	assert.equal(reported, false);
});
