import assert from "node:assert/strict";
import test from "node:test";
import {
	isFocusedFromPids,
	parseWindowsFocusSnapshot,
	powershellStringLiteral,
} from "../extensions/tool-guard/desktop-notify-utils.ts";

test("parses a Windows foreground/ancestry snapshot", () => {
	const snapshot = parseWindowsFocusSnapshot('{"foregroundPid":42,"ancestorPids":[100,42,1]}');

	assert.equal(snapshot?.foregroundPid, 42);
	assert.deepEqual(snapshot?.ancestorPids, new Set([100, 42, 1]));
	assert.equal(isFocusedFromPids(snapshot?.foregroundPid, snapshot?.ancestorPids ?? new Set()), true);
});

test("rejects unusable Windows focus snapshots", () => {
	assert.equal(parseWindowsFocusSnapshot(undefined), undefined);
	assert.equal(parseWindowsFocusSnapshot("not json"), undefined);
	assert.equal(parseWindowsFocusSnapshot('{"foregroundPid":0,"ancestorPids":[1]}'), undefined);
	assert.equal(parseWindowsFocusSnapshot('{"foregroundPid":1,"ancestorPids":[]}'), undefined);
});

test("distinguishes focused, unfocused, and unknown PID state", () => {
	const ancestors = new Set([10, 20, 30]);
	assert.equal(isFocusedFromPids(20, ancestors), true);
	assert.equal(isFocusedFromPids(99, ancestors), false);
	assert.equal(isFocusedFromPids(undefined, ancestors), undefined);
});

test("PowerShell literals do not interpolate notification content", () => {
	assert.equal(powershellStringLiteral("plain"), "'plain'");
	assert.equal(powershellStringLiteral("don't run $(Get-Process) `whoami`"), "'don''t run $(Get-Process) `whoami`'");
});
