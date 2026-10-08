export function staticShellWord(source: string, env?: Record<string, string | undefined>, mode: "argument" | "assignment" = "argument"): string | undefined {
	const variable = (index: number, quoted: boolean): { value: string; end: number } | undefined => {
		if (!env) return undefined;
		const match = source.slice(index).match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/);
		if (!match) return undefined;
		const value = env[match[1] ?? match[2]];
		if (!quoted && mode === "argument" && env.IFS !== undefined && env.IFS !== " \t\n") return undefined;
		if (value === undefined || value.includes("\0") || (!quoted && mode === "argument" && (!value || /[\s*?\[\]]/.test(value)))) return undefined;
		return { value, end: index + match[0].length - 1 };
	};
	let result = "";
	let quote: "single" | "double" | undefined;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (quote === "single") {
			if (character === "'") quote = undefined;
			else result += character;
			continue;
		}
		if (quote === "double") {
			if (character === '"') quote = undefined;
			else if (character === "$") {
				const expansion = variable(index, true);
				if (!expansion) return undefined;
				result += expansion.value;
				index = expansion.end;
			} else if (character === "`") return undefined;
			else if (character === "\\" && index + 1 < source.length) {
				const next = source[index + 1];
				if (next === "\n") index += 1;
				else if (["$", "`", '"', "\\"].includes(next)) {
					result += next;
					index += 1;
				} else result += character;
			} else result += character;
			continue;
		}
		if (character === "'") quote = "single";
		else if (character === '"') quote = "double";
		else if (character === "\\") {
			if (index + 1 === source.length) return undefined;
			const next = source[++index];
			if (next !== "\n") result += next;
		} else if (character === "$") {
			const expansion = variable(index, false);
			if (!expansion) return undefined;
			result += expansion.value;
			index = expansion.end;
		} else if (character === "`" || "*?[{();&|<>".includes(character) || (character === "~" && index === 0)) return undefined;
		else result += character;
	}
	return quote ? undefined : result;
}
