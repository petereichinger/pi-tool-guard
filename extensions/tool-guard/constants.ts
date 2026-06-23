export const SESSION_RULES_ENTRY_TYPE = "tool-guard-session-rules";
export const LEGACY_SESSION_RULES_ENTRY_TYPE = "simple-permissions-session-rules";

export const WRITING_TOOLS = new Set(["write", "edit"]);

export const READ_ONLY_COMMANDS = new Set([
	":",
	"true",
	"false",
	"pwd",
	"ls",
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"wc",
	"sort",
	"uniq",
	"cut",
	"diff",
	"cmp",
	"comm",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"fd",
	"fdfind",
	"awk",
	"sed",
	"find",
	"stat",
	"file",
	"du",
	"df",
	"ps",
	"date",
	"whoami",
	"id",
	"uname",
	"which",
	"whereis",
	"type",
	"command",
	"echo",
	"printf",
	"test",
	"[",
	"git",
]);

export const GIT_READ_ONLY_SUBCOMMANDS = new Set([
	"status",
	"diff",
	"log",
	"show",
	"branch",
	"tag",
	"rev-parse",
	"rev-list",
	"ls-files",
	"ls-tree",
	"grep",
	"blame",
	"remote",
]);

export const FIND_MUTATING_FLAGS = new Set([
	"-delete",
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-fprint",
	"-fprint0",
	"-fprintf",
]);

export const FD_EXEC_FLAGS = new Set(["-x", "-X", "--exec", "--exec-batch"]);

export const FD_SHORT_OPTIONS_WITH_VALUES = new Set([
	"t",
	"e",
	"E",
	"c",
	"d",
	"j",
	"S",
	"C",
]);

export const DIRECT_MODULE_ENTRY_CANDIDATES: Record<string, string[]> = {
	"tree-sitter": ["node_modules/tree-sitter/index.js"],
	"tree-sitter-bash": ["node_modules/tree-sitter-bash/bindings/node/index.js"],
};
