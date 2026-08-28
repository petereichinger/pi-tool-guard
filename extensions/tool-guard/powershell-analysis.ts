import type { BashAnalysis } from "./types.ts";

/**
 * PowerShell has no bundled Tree-sitter grammar here. Treat the complete script
 * as one potentially harmful command so it can never bypass the permission
 * gate through PowerShell-specific syntax. Command allow/deny rules still
 * match the exact script text.
 */
export function analyzePowerShell(command: string): BashAnalysis {
	if (!command.trim()) return { parserAvailable: true, commands: [] };
	return {
		parserAvailable: true,
		commands: [
			{
				command,
				name: "powershell",
				harmless: false,
				reason: "PowerShell scripts require explicit approval",
			},
		],
	};
}
