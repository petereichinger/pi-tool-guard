import assert from "node:assert/strict";
import test from "node:test";

import { staticShellWord } from "../extensions/tool-guard/shell-word.ts";

test("decodes literal quotes, escaped characters, and adjacent word fragments", () => {
	for (const [source, expected] of [
		["plain/path", "plain/path"],
		["'some path'", "some path"],
		['"some path"', "some path"],
		["some\\ path", "some path"],
		["'some '\"path\"", "some path"],
		["''", ""],
		['""', ""],
		["'${NAME} $(pwd) `pwd` * ? [x] ~'", "${NAME} $(pwd) `pwd` * ? [x] ~"],
		["\\$NAME", "$NAME"],
		["\\*\\?\\[x\\]", "*?[x]"],
		['"\\$NAME \\`pwd\\` \\"quoted\\" \\\\"', '$NAME `pwd` "quoted" \\'],
		['"path\\q"', "path\\q"],
		["some\\\npath", "somepath"],
		['"some\\\npath"', "somepath"],
	]) {
		assert.equal(staticShellWord(source), expected, source);
	}
});

test("expands named variables only when an environment is supplied", () => {
	const env = { NAME: "repo", NAME_suffix: "whole", _ROOT2: "root" };
	for (const [source, expected] of [
		["$NAME", "repo"],
		["${NAME}", "repo"],
		['"$NAME"', "repo"],
		["prefix/${NAME}/suffix", "prefix/repo/suffix"],
		["${NAME}_suffix", "repo_suffix"],
		["$NAME_suffix", "whole"],
		["$_ROOT2", "root"],
		["'$NAME'", "$NAME"],
		["\\$NAME", "$NAME"],
	]) {
		assert.equal(staticShellWord(source, env), expected, source);
	}
	assert.equal(staticShellWord("$NAME"), undefined);
	assert.equal(staticShellWord('"${NAME}"'), undefined);
});

test("accepts an explicitly supplied inherited environment", (t) => {
	const key = "PI_TOOL_GUARD_SHELL_WORD_TEST";
	const previous = process.env[key];
	t.after(() => {
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	});
	process.env[key] = "inherited/path";
	assert.equal(staticShellWord(`$${key}`, process.env), "inherited/path");
	assert.equal(staticShellWord(`$${key}`), undefined);
});

test("rejects missing variables in either quoting mode", () => {
	for (const source of ["$MISSING", "${MISSING}", '"$MISSING"', '"${MISSING}"']) {
		assert.equal(staticShellWord(source, {}), undefined, source);
		assert.equal(staticShellWord(source, { MISSING: undefined }), undefined, source);
	}
});

test("rejects unquoted empty, whitespace, and glob expansions but permits them in double quotes", () => {
	for (const value of ["", "two words", "tab\there", "line\nbreak", "*.ts", "file?", "[ab]", "closing]"]) {
		const env = { VALUE: value };
		assert.equal(staticShellWord("$VALUE", env), undefined, JSON.stringify(value));
		assert.equal(staticShellWord("prefix${VALUE}suffix", env), undefined, JSON.stringify(value));
		assert.equal(staticShellWord('"$VALUE"', env), value);
		assert.equal(staticShellWord('"prefix${VALUE}suffix"', env), `prefix${value}suffix`);
	}
	assert.equal(staticShellWord("$VALUE", { VALUE: "a\0b" }), undefined);
	assert.equal(staticShellWord('"$VALUE"', { VALUE: "a\0b" }), undefined);
});

test("assignment expansion does not perform field splitting or pathname expansion", () => {
	for (const value of ["", "some home", "repo*", "file?"]) {
		assert.equal(staticShellWord("$VALUE", { VALUE: value }, "assignment"), value);
	}
});

test("requires quotes for argument expansion with a custom IFS", () => {
	assert.equal(staticShellWord("$VALUE", { VALUE: "some:path", IFS: ":" }), undefined);
	assert.equal(staticShellWord('"$VALUE"', { VALUE: "some:path", IFS: ":" }), "some:path");
});

test("does not recursively evaluate expansion values", () => {
	const value = "$(pwd);$OTHER`pwd`~{a,b}";
	assert.equal(staticShellWord("$VALUE", { VALUE: value }), value);
	assert.equal(staticShellWord('"$VALUE"', { VALUE: value }), value);
});

test("rejects substitutions, parameter modifiers, and dynamic word syntax", () => {
	for (const source of [
		"$(pwd)", '"$(pwd)"', "`pwd`", '"`pwd`"', "$((1 + 2))",
		"${NAME:-fallback}", "${NAME-fallback}", "${NAME:=fallback}", "${NAME:+other}",
		"${NAME:?error}", "${NAME%tail}", "${NAME#head}", "${!NAME}", "${#NAME}",
		"$?", "$1", "$@", "$'quoted'", "$", "~/repo", "*.ts", "file?", "[ab]", "{a,b}",
		"<(pwd)", ">(pwd)", "'unfinished", '"unfinished', "trailing\\",
	]) {
		assert.equal(staticShellWord(source, { NAME: "repo" }), undefined, source);
	}
});

test("rejects bare shell operators while retaining quoted or escaped literals", () => {
	for (const operator of [";", "&", "|", "<", ">", "(", ")"]) {
		assert.equal(staticShellWord(`left${operator}right`), undefined, operator);
		assert.equal(staticShellWord(`'left${operator}right'`), `left${operator}right`);
		assert.equal(staticShellWord(`"left${operator}right"`), `left${operator}right`);
		assert.equal(staticShellWord(`left\\${operator}right`), `left${operator}right`);
	}
});
