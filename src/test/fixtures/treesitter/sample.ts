export class Widget {
	render(): number {
		return 1;
	}
}

export function createWidget(): Widget {
	return new Widget();
}

export type WidgetId = string;
