import type { ChatUiMessage } from './protocol';

function messageId(): string {
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Снять внешнюю ```-ограду у тела Tool-секции (как в export)
function unwrapToolFence(raw: string): string {
	const trimmed = raw.trim();
	const match = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(trimmed);
	if (match) {
		return match[1] ?? '';
	}

	// Ограда без завершающего перевода строки перед ```
	const loose = /^```[^\n]*\n([\s\S]*?)```$/.exec(trimmed);
	return loose?.[1] ?? trimmed;
}

function sectionToMessage(heading: string, body: string): ChatUiMessage | undefined {
	const h = heading.trim();

	if (h === 'Пользователь') {
		const content = body.trim();
		if (!content) {
			return undefined;
		}

		return { 
			id: messageId(), 
			role: 'user', 
			content 
		};
	}

	if (h === 'Ассистент') {
		const content = body.trim();
		if (!content) {
			return undefined;
		}

		return { 
			id: messageId(), 
			role: 'assistant', 
			content 
		};
	}

	if (h === 'Ошибка') {
		const content = body.trim();
		if (!content) {
			return undefined;
		}

		return { 
			id: messageId(), 
			role: 'error', 
			content 
		};
	}

	// ## Tool name  или  ## Tool (без имени)
	if (h === 'Tool' || h.startsWith('Tool ')) {
		const toolName = h === 'Tool' ? undefined : h.slice('Tool '.length).trim() || undefined;
		const content = unwrapToolFence(body).trim();
		if (!content) {
			return undefined;
		}

		// Tool-секция * role tool; без имени - assistant с тем же content
		if (toolName) {
			return { 
				id: messageId(), 
				role: 'tool', 
				content, toolName 
			};
		}

		return { 
			id: messageId(), 
			role: 'assistant', 
			content 
		};
	}

	return undefined;
}

/**
 * Разбор markdown экспорта (`# Экспорт чата Haratsan` + секции `## ...`).
 * Пустые секции пропускаются; id сообщений - новые.
 */
export function parseExportedMarkdown(md: string): ChatUiMessage[] {
	const text = md.replace(/\r\n/g, '\n');
	const parts = text.split(/^## /m);
	const messages: ChatUiMessage[] = [];

	// parts[0] - заголовок / преамбула до первой ##
	for (let i = 1; i < parts.length; i++) {
		const part = parts[i]!;
		const nl = part.indexOf('\n');
		const heading = (nl === -1 ? part : part.slice(0, nl)).trimEnd();
		const body = nl === -1 ? '' : part.slice(nl + 1);
		const msg = sectionToMessage(heading, body);
		if (msg) {
			messages.push(msg);
		}
	}

	return messages;
}
