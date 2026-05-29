import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DIRECT_MODULE_ENTRY_CANDIDATES } from "./constants.ts";

let bashParserPromise: Promise<{ parser: any | null; error?: string }> | undefined;

const extensionFilePath = fileURLToPath(import.meta.url);
const extensionDir = dirname(extensionFilePath);
const extensionFileRequire = createRequire(import.meta.url);

function collectRequireBases(): string[] {
	const seen = new Set<string>();
	const bases: string[] = [];
	const add = (value: string) => {
		const dir = resolve(value);
		if (seen.has(dir)) return;
		seen.add(dir);
		bases.push(dir);
	};

	add(extensionDir);
	add(resolve(extensionDir, ".."));
	add(process.cwd());

	for (const start of [...bases]) {
		let current = start;
		while (true) {
			add(current);
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}

	return bases;
}

function withBunCompat<T>(load: () => T): T {
	if (typeof process.versions.bun !== "string") return load();

	const versions = process.versions as NodeJS.ProcessVersions & { bun?: string };
	const descriptor = Object.getOwnPropertyDescriptor(versions, "bun");
	const hadBun = Object.prototype.hasOwnProperty.call(versions, "bun");
	const bunVersion = versions.bun;

	try {
		if (descriptor?.writable) versions.bun = undefined;
		else if (descriptor?.configurable) delete versions.bun;
		return load();
	} finally {
		if (!hadBun) return;
		if (descriptor) Object.defineProperty(versions, "bun", { ...descriptor, value: bunVersion });
		else if (bunVersion) versions.bun = bunVersion;
	}
}

function tryLoadWithRequire(requireFn: NodeJS.Require, request: string, attempted: string[], lastErrorRef: { value: unknown }) {
	attempted.push(request);
	try {
		return { loaded: true as const, value: requireFn(request) };
	} catch (error) {
		lastErrorRef.value = error;
		return { loaded: false as const };
	}
}

function resolveDirectModuleEntryPaths(moduleName: string, bases: string[]): string[] {
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const relativeEntry of DIRECT_MODULE_ENTRY_CANDIDATES[moduleName] ?? []) {
		for (const base of bases) {
			const entryPath = join(base, relativeEntry);
			if (!existsSync(entryPath) || seen.has(entryPath)) continue;
			seen.add(entryPath);
			paths.push(entryPath);
		}
	}
	return paths;
}

function requireExtensionDependency(moduleName: string): any {
	return withBunCompat(() => {
		const attempted: string[] = [];
		const lastErrorRef: { value: unknown } = { value: undefined };
		const bases = collectRequireBases();

		for (const base of bases) {
			const packageJsonPath = join(base, "package.json");
			if (!existsSync(packageJsonPath)) continue;
			const result = tryLoadWithRequire(createRequire(packageJsonPath), moduleName, attempted, lastErrorRef);
			if (result.loaded) return result.value;
		}

		const extensionResult = tryLoadWithRequire(extensionFileRequire, moduleName, attempted, lastErrorRef);
		if (extensionResult.loaded) return extensionResult.value;

		for (const entryPath of resolveDirectModuleEntryPaths(moduleName, bases)) {
			const result = tryLoadWithRequire(extensionFileRequire, entryPath, attempted, lastErrorRef);
			if (result.loaded) return result.value;
		}

		const detail = lastErrorRef.value instanceof Error ? (lastErrorRef.value.stack ?? lastErrorRef.value.message) : String(lastErrorRef.value);
		throw new Error(`Unable to load ${moduleName}. Attempted roots:\n${attempted.join("\n")}\n\nLast error: ${detail}`);
	});
}

function moduleDefault<T>(value: T): T {
	return ((value as any)?.default ?? value) as T;
}

function mutableModuleExports<T extends object>(value: T): T {
	return Object.assign({}, value);
}

export async function getBashParser(): Promise<{ parser: any | null; error?: string }> {
	bashParserPromise ??= (async () => {
		try {
			const Parser = moduleDefault<any>(requireExtensionDependency("tree-sitter"));
			const Bash = mutableModuleExports(moduleDefault<any>(requireExtensionDependency("tree-sitter-bash")));
			const parser = new Parser();
			parser.setLanguage(Bash);
			return { parser };
		} catch (error: any) {
			return { parser: null, error: error?.stack ?? error?.message ?? String(error) };
		}
	})();
	return bashParserPromise;
}
