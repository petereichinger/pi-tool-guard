import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";

export class GuardSelectionDialog extends Container {
	private readonly list = new Container();
	private readonly title: Text;
	private readonly getTitle: () => string;
	private readonly options: string[];
	private readonly theme: Theme;
	private readonly onSelect: (option: string) => void;
	private readonly onCancel: () => void;
	private readonly requestRender: () => void;
	private selectedIndex = 0;

	constructor(
		getTitle: () => string,
		options: string[],
		theme: Theme,
		onSelect: (option: string) => void,
		onCancel: () => void,
		requestRender: () => void,
	) {
		super();
		this.getTitle = getTitle;
		this.options = options;
		this.theme = theme;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.requestRender = requestRender;
		this.title = new Text("", 1, 0);
		this.addChild(new DynamicBorder((text: string) => this.theme.fg("border", text)));
		this.addChild(new Spacer(1));
		this.addChild(this.title);
		this.addChild(new Spacer(1));
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("dim", "↑↓ navigate  enter select  escape/ctrl+c cancel"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((text: string) => this.theme.fg("border", text)));
		this.rebuild();
	}

	private rebuild(): void {
		this.title.setText(this.getTitle());
		this.list.clear();
		for (let index = 0; index < this.options.length; index++) {
			const option = this.options[index]!;
			const selected = index === this.selectedIndex;
			const marker = selected ? this.theme.fg("accent", "→ ") : "  ";
			const label = selected ? this.theme.bold(option) : option;
			this.list.addChild(new Text(`${marker}${this.theme.fg("accent", label)}`, 1, 0));
		}
	}

	override handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up") || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.rebuild();
			this.requestRender();
			return;
		}
		if (keybindings.matches(data, "tui.select.down") || data === "j") {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.rebuild();
			this.requestRender();
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm") || data === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) this.onSelect(selected);
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c")) this.onCancel();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}
}
