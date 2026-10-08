import { realpath, stat } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";

export function normalizeShellPathForHost(path: string, platform: NodeJS.Platform = process.platform): string {
	if (platform !== "win32") return path;
	const msysDrivePath = path.match(/^\/([a-zA-Z])(?:\/(.*))?$/);
	return msysDrivePath ? `${msysDrivePath[1].toUpperCase()}:/${msysDrivePath[2] ?? ""}` : path;
}

export function physicalShellPath(base: string, path: string): string {
	const normalized = normalizeShellPathForHost(path);
	if (process.platform === "win32" && (
		/^[a-zA-Z]:(?![\\/])/.test(normalized) ||
		(normalized.startsWith("/") && !normalized.startsWith("//")) ||
		(normalized.startsWith("\\") && !normalized.startsWith("\\\\"))
	)) throw new Error(`Shell path has an ambiguous Windows root: ${path}`);
	return isAbsolute(normalized) ? normalized : `${base}${sep}${normalized}`;
}

export async function shellDirectory(path: string): Promise<string> {
	const canonical = await realpath(normalizeShellPathForHost(path));
	if (!(await stat(canonical)).isDirectory()) throw new Error(`Not a directory: ${path}`);
	return canonical;
}
