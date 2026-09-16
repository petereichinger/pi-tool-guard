import assert from "node:assert/strict";
import test from "node:test";
import { GuardSelectionDialog } from "../extensions/tool-guard/selection-dialog.ts";
import { editRegexRule, selectBashDecision } from "../extensions/tool-guard/ui.ts";

test("permission prompt entries use one theme color", async () => {
	let request: { title: string; options: string[] } | undefined;
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bold: (text: string) => `<bold>${text}</bold>`,
	};
	const ctx = {
		ui: {
			theme,
			select: async (title: string, options: string[]) => {
				request = { title, options };
				return options[1];
			},
		},
	};
	const evaluatedCommand = {
		index: 0,
		command: "npm install foo",
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

	assert.deepEqual(decision, { type: "block" });
	assert.match(request!.title, /<warning><bold>Allow bash command\?<\/bold><\/warning>/);
	assert.match(request!.title, /<mdCode><bold>npm install foo<\/bold><\/mdCode>/);
	assert.deepEqual(request!.options, [
		"<accent>Allow once</accent>",
		"<accent>Deny</accent>",
		"<accent>Save allow rule…</accent>",
	]);
});

test("interactive permission prompt renders only the selected entry in bold", () => {
	const theme = {
		fg: (_color: string, text: string) => `\x1b[35m${text}\x1b[39m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	};
	const dialog = new GuardSelectionDialog(
		() => "Title",
		["Allow once", "Deny", "Save allow rule…"],
		theme as any,
		() => {},
		() => {},
		() => {},
	);

	let rendered = dialog.render(120).join("\n");
	assert.match(rendered, /\x1b\[35m\x1b\[1mAllow once\x1b\[22m\x1b\[39m/);
	assert.doesNotMatch(rendered, /\x1b\[1mDeny/);

	dialog.handleInput("j");
	rendered = dialog.render(120).join("\n");
	assert.match(rendered, /\x1b\[35m\x1b\[1mDeny\x1b\[22m\x1b\[39m/);
	assert.doesNotMatch(rendered, /\x1b\[1mAllow once/);
});

for (const mode of ["tui", "rpc"] as const) {
	test(`${mode} regex editing uses the same prefilled editor and keeps the command visible`, async () => {
		const calls: unknown[][] = [];
		const ctx = {
			mode,
			ui: {
				editor: async (...args: unknown[]) => {
					calls.push(args);
					return "edited";
				},
				custom: async () => {
					throw new Error("custom UI should not be used");
				},
			},
		};

		const result = await editRegexRule(ctx, "Bash allow regex", "npm install foo", "^npm install foo$");

		assert.equal(result, "edited");
		assert.deepEqual(calls, [["Bash allow regex\n\nCommand: npm install foo", "^npm install foo$"]]);
	});

	test(`${mode} bash permissions use the same sequential dialogs`, async () => {
		const requests: Array<{ title: string; options: string[] }> = [];
		const responses = ["Save allow rule…", "session", "Regex rule"];
		const ctx = {
			mode,
			ui: {
				select: async (title: string, options: string[]) => {
					requests.push({ title, options });
					return responses.shift();
				},
				custom: async () => {
					throw new Error("custom UI should not be used");
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

	test(`${mode} PowerShell permissions identify the guarded shell`, async () => {
		const requests: Array<{ title: string; options: string[] }> = [];
		const ctx = {
			mode,
			ui: {
				select: async (title: string, options: string[]) => {
					requests.push({ title, options });
					return "Deny";
				},
			},
		};
		const command = "Remove-Item tmp";
		const evaluatedCommand = {
			index: 0,
			command,
			name: "powershell",
			harmless: false,
			reason: "PowerShell scripts require explicit approval",
			allowedOnce: false,
		};

		const decision = await selectBashDecision(
			ctx,
			{ commands: [evaluatedCommand], pendingDangerous: [evaluatedCommand] },
			{ parserAvailable: true, commands: [evaluatedCommand] },
			0,
			{ repoLocation: undefined } as any,
			"action",
			"PowerShell",
		);

		assert.deepEqual(decision, { type: "block" });
		assert.match(requests[0]!.title, /^Allow powershell command\?/);
	});
}
