import assert from "node:assert/strict";
import test from "node:test";

import { analyzeBash } from "../extensions/tool-guard/bash-analysis.ts";

test("allows a read-only command that discards output to /dev/null", async () => {
	for (const redirect of [">/dev/null", "2>/dev/null", "&>/dev/null"]) {
		const analysis = await analyzeBash(`rg -n "issue.?8|#8|TODO|planned" README.md AGENTS.md .forgejo .git ${redirect}`);
		assert.deepEqual(analysis.commands.map(({ name, harmless, reason }) => ({ name, harmless, reason })), [
			{ name: "rg", harmless: true, reason: "known read-only command" },
		]);
	}
});

test("analyzes a quoted ssh remote command command-by-command", async () => {
	const analysis = await analyzeBash("ssh host 'ls && rm -rf /tmp/example'");

	assert.deepEqual(
		analysis.commands.map(({ command, name, harmless, splitter }) => ({ command, name, harmless, splitter })),
		[
			{ command: "ssh host", name: "ssh", harmless: false, splitter: undefined },
			{ command: "ls", name: "ls", harmless: true, splitter: "ssh remote →" },
			{ command: "rm -rf /tmp/example", name: "rm", harmless: false, splitter: "&&" },
		],
	);
});

test("accounts for ssh options and space-joined remote argv", async () => {
	const analysis = await analyzeBash("ssh -p 2222 host echo 'okay; touch /tmp/example'");

	assert.equal(analysis.commands[0].command, "ssh -p 2222 host");
	assert.deepEqual(
		analysis.commands.slice(1).map(({ command, harmless }) => ({ command, harmless })),
		[
			{ command: "echo okay", harmless: true },
			{ command: "touch /tmp/example", harmless: false },
		],
	);
});

test("does not guess an ssh command containing local expansion", async () => {
	const analysis = await analyzeBash('ssh host "$REMOTE_COMMAND"');

	assert.equal(analysis.commands.length, 1);
	assert.equal(analysis.commands[0].name, "ssh");
	assert.equal(analysis.commands[0].harmless, false);
});
