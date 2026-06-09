export type BashRuleScope = "session" | "directory" | "repo" | "global";
export type PersistentBashRuleScope = Exclude<BashRuleScope, "session">;
export type BashRuleList = "allow" | "deny";

export type BashRule = {
	source: string;
	regex: RegExp;
	scope: BashRuleScope;
	list: BashRuleList;
	description?: string;
};

export type StoredBashRule = string | { source?: unknown; description?: unknown };
export type StoredWriteDirectoryRule = string | { path?: unknown; description?: unknown };

export type WriteDirectoryRule = {
	path: string;
	scope: BashRuleScope;
	description?: string;
};

export type PermissionConfig = {
	version?: number;
	bash?: {
		allow?: StoredBashRule[];
		deny?: StoredBashRule[];
	};
	write?: {
		allowDirectories?: StoredWriteDirectoryRule[];
	};
	bashAllowRules?: StoredBashRule[];
};

export type RepoConfigLocation = {
	repoRoot: string;
	commonDir: string;
	configPath: string;
};

export type LoadedConfigFile = {
	path: string;
	scope: PersistentBashRuleScope;
	config: PermissionConfig;
	allowRules: BashRule[];
	denyRules: BashRule[];
	writeAllowDirectories: WriteDirectoryRule[];
	errors: string[];
};

export type LoadedConfigState = {
	cwd: string;
	global: LoadedConfigFile;
	directory: LoadedConfigFile;
	repo?: LoadedConfigFile;
	repoLocation?: RepoConfigLocation;
	allowRules: BashRule[];
	denyRules: BashRule[];
	writeAllowDirectories: WriteDirectoryRule[];
	errors: string[];
};

export type LoadedSessionRuleState = {
	allowRules: BashRule[];
	denyRules: BashRule[];
	writeAllowDirectories: string[];
	errors: string[];
};

export type BashCommandRisk = {
	command: string;
	name: string;
	harmless: boolean;
	reason: string;
	splitter?: string;
};

export type BashAnalysis = {
	parserAvailable: boolean;
	commands: BashCommandRisk[];
	error?: string;
};

export type BashRuleDecision = { type: "allow" | "deny"; rule: BashRule };

export type EvaluatedBashCommand = BashCommandRisk & {
	index: number;
	allowedOnce: boolean;
	ruleDecision?: BashRuleDecision;
};

export type BashAnalysisEvaluation = {
	commands: EvaluatedBashCommand[];
	denied?: EvaluatedBashCommand;
	pendingDangerous: EvaluatedBashCommand[];
};

export type BashSaveMode = "exact" | "regex";

export type BashDialogDecision =
	| { type: "allow-once" }
	| { type: "block" }
	| { type: "save"; scope: BashRuleScope; mode: BashSaveMode };

export type FileMutationSaveMode = "folder" | "custom";

export type FileMutationDecision =
	| { type: "allow-once" }
	| { type: "block" }
	| { type: "save"; scope: BashRuleScope; mode: FileMutationSaveMode };
