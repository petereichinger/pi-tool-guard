export function staticShellWord(source: string): string | undefined {
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
			else if (character === "$" || character === "`") return undefined;
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
		} else if (character === "$" || character === "`" || "*?[{()".includes(character) || (character === "~" && index === 0)) return undefined;
		else result += character;
	}
	return quote ? undefined : result;
}
