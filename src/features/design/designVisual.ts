/**
 * Визуальный MVP Design Mode - не заглушка.
 *
 * Честные лимиты: не полный click-to-code в браузере. Эвристический inspect через fetch_page + CSS-селектор + grep workspace по className/id.
 */

export interface DesignClickPayload {
	url: string;
	selector?: string;
	snippet?: string;
	x?: number;
	y?: number;
	sourceHint?: string;
}

export interface DesignClickResult {
	ok: boolean;
	handled: boolean;
	message: string;
}

export const DESIGN_CLICK_PROTOCOL = 'haratsan.design.click' as const;

// Заметка про инъекцию Simple Browser / preview (host-доки для будущей проводки)
export const DESIGN_SIMPLE_BROWSER_NOTE =
	'Design visual MVP: use tool design_inspect(url, selector). ' +
	'fetch_page annotates HTML with data-gen-src hints when sourceMappingURL is present. ' +
	'Full click-to-code in Simple Browser is not wired - no DOM click bridge yet.';

/**
 * Аннотировать полученный HTML комментарием + data-атрибутом, если есть source map hint.
 * JS не исполняет; безопасно для контекста агента.
 */
export function annotateHtmlWithSourceHints(html: string, pageUrl: string): {
	html: string;
	sourceMapHint?: string;
	note: string;
} {
	const mapMatch = html.match(/\/\/[#@]\s*sourceMappingURL\s*=\s*(\S+)/i) ||
		html.match(/\/\*[#@]\s*sourceMappingURL\s*=\s*(\S+)\s*\*\//i) ||
		html.match(/sourceMappingURL=([^\s"']+)/i);

	const sourceMapHint = mapMatch?.[1]?.replace(/["'>].*$/, '');
	const comment = sourceMapHint
		? `<!-- gen-design: url=${pageUrl} sourceMappingURL=${sourceMapHint} -->`
		: `<!-- gen-design: url=${pageUrl}; no sourceMappingURL in response - design_inspect uses class/id grep -->`;

	let annotated = html;
	if (/<html\b/i.test(annotated)) {
		annotated = annotated.replace(/<html\b([^>]*)>/i, (_m, attrs: string) => {
			if (/\bdata-gen-src\b/i.test(attrs)) {
				return `<html${attrs}>`;
			}
			const hint = sourceMapHint ?? pageUrl;
			return `<html${attrs} data-gen-src="${hint.replace(/"/g, '&quot;')}">`;
		});
	}

	if (!annotated.includes('gen-design:')) {
		annotated = `${comment}\n${annotated}`;
	}

	return {
		html: annotated,
		sourceMapHint,
		note: DESIGN_SIMPLE_BROWSER_NOTE,
	};
}

// Извлечь outerHTML-подобный фрагмент первого элемента по простому CSS-селектору (id/class/tag)
export function extractSelectorOuterHtml(html: string, selector: string, maxChars = 4_000): { matched: boolean; outerHtml?: string; matchedBy?: string } {
	const sel = selector.trim();
	if (!sel) {
		return { matched: false };
	}

	// #id
	if (sel.startsWith('#') && /^#[A-Za-z_][\w-]*$/.test(sel)) {
		const id = sel.slice(1);
		const re = new RegExp(
			`<([a-zA-Z][\\w-]*)([^>]*\\sid\\s*=\\s*["']${id}["'][^>]*)>([\\s\\S]*?)<\\/\\1>`,
			'i',
		);
		const m = re.exec(html);
		if (m) {
			const outer = m[0].slice(0, maxChars);
			return { 
				matched: true, 
				outerHtml: outer, 
				matchedBy: `id=${id}` 
			};
		}
		// self-closing / без детей
		const re2 = new RegExp(
			`<([a-zA-Z][\\w-]*)([^>]*\\sid\\s*=\\s*["']${id}["'][^>]*)\\/?>`,
			'i',
		);
		const m2 = re2.exec(html);
		if (m2) {
			return { 
				matched: true, 
				outerHtml: m2[0].slice(0, maxChars), 
				matchedBy: `id=${id}` 
			};
		}
	}

	// .class (первый class-токен)
	if (sel.startsWith('.') && /^\.[A-Za-z_][\w-]*$/.test(sel)) {
		const cls = sel.slice(1);
		const re = new RegExp(
			`<([a-zA-Z][\\w-]*)([^>]*\\sclass\\s*=\\s*["'][^"']*\\b${cls}\\b[^"']*["'][^>]*)>([\\s\\S]*?)<\\/\\1>`,
			'i',
		);
		const m = re.exec(html);
		if (m) {
			return { 
				matched: true, 
				outerHtml: m[0].slice(0, maxChars), 
				matchedBy: `class=${cls}` 
			};
		}
	}

	// тег
	if (/^[a-zA-Z][\w-]*$/.test(sel)) {
		const re = new RegExp(`<(${sel})(\\s[^>]*)?>([\\s\\S]*?)<\\/${sel}>`, 'i');
		const m = re.exec(html);
		if (m) {
			return {
				matched: true, 
				outerHtml: m[0].slice(0, maxChars),
				matchedBy: `tag=${sel}` 
			};
		}
	}

	return { matched: false };
}

// Токены из селектора для grep по workspace (имена class / id)
export function selectorSearchTokens(selector: string): string[] {
	const tokens: string[] = [];
	const id = /#([A-Za-z_][\w-]*)/g;
	const cls = /\.([A-Za-z_][\w-]*)/g;
	let m: RegExpExecArray | null;
	while ((m = id.exec(selector))) {
		tokens.push(m[1]!);
	}

	while ((m = cls.exec(selector))) {
		tokens.push(m[1]!);
	}

	if (tokens.length === 0 && /^[A-Za-z_][\w-]*$/.test(selector.trim())) {
		tokens.push(selector.trim());
	}

	return [...new Set(tokens)];
}

export function handleDesignClick(_payload: DesignClickPayload): DesignClickResult {
	return {
		ok: false,
		handled: false,
		message: 'Design Mode visual: browser click-to-code не подключён. Используй design_inspect(url, selector) или open_browser + fetch_page.',
	};
}
