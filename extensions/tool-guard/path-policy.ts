import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export function stripAtPrefix(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

export function isInside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel));
}

export async function realpathOrResolve(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

export async function canonicalizeForPolicy(absolutePath: string): Promise<string> {
	let current = absolutePath;
	const missingParts: string[] = [];

	while (true) {
		try {
			const real = await realpath(current);
			return missingParts.length === 0 ? real : resolve(real, ...missingParts);
		} catch {
			const parent = dirname(current);
			if (parent === current) return resolve(absolutePath);
			missingParts.unshift(basename(current));
			current = parent;
		}
	}
}
