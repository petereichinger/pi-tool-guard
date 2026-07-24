export type WindowsFocusSnapshot = {
	foregroundPid: number;
	ancestorPids: Set<number>;
};

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function parseWindowsFocusSnapshot(output: string | undefined): WindowsFocusSnapshot | undefined {
	if (!output) return undefined;
	try {
		const parsed = JSON.parse(output) as { foregroundPid?: unknown; ancestorPids?: unknown };
		const foregroundPid = positiveInteger(parsed.foregroundPid);
		if (!foregroundPid || !Array.isArray(parsed.ancestorPids)) return undefined;

		const ancestorPids = new Set<number>();
		for (const value of parsed.ancestorPids) {
			const pid = positiveInteger(value);
			if (pid) ancestorPids.add(pid);
		}
		return ancestorPids.size > 0 ? { foregroundPid, ancestorPids } : undefined;
	} catch {
		return undefined;
	}
}

export function isFocusedFromPids(activePid: number | undefined, ancestorPids: Set<number>): boolean | undefined {
	return activePid ? ancestorPids.has(activePid) : undefined;
}

/** A literal with no PowerShell interpolation, including for `$()` and backticks. */
export function powershellStringLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}
