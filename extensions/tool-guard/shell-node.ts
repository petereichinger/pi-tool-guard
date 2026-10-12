export function sameShellNode(a: any, b: any): boolean {
	// Native parser nodes can have different JavaScript wrappers after garbage collection.
	return !!a && !!b && a.type === b.type && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
}
