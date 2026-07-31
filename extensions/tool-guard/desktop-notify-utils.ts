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

export function ghosttySurfaceId(value: string | undefined): string | undefined {
	if (!value || !/^(?:0x[\da-f]+|\d+)$/i.test(value)) return undefined;
	try {
		const id = BigInt(value);
		return id > 0n && id <= 0xffff_ffff_ffff_ffffn ? id.toString() : undefined;
	} catch {
		return undefined;
	}
}

export function niriWindowIdForPids(output: string | undefined, pids: Set<number>): number | undefined {
	if (!output) return undefined;
	try {
		const windows = JSON.parse(output) as unknown;
		if (!Array.isArray(windows)) return undefined;
		for (const window of windows) {
			if (!window || typeof window !== "object") continue;
			const { id, pid } = window as { id?: unknown; pid?: unknown };
			const windowId = positiveInteger(id);
			const windowPid = positiveInteger(pid);
			if (windowId && windowPid && pids.has(windowPid)) return windowId;
		}
	} catch {}
	return undefined;
}

/** A literal with no PowerShell interpolation, including for `$()` and backticks. */
export function powershellStringLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}
