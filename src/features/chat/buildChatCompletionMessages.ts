import type { ChatContentPart, ChatMessage } from '../../core/llm/types';
import type { ChatUiMessage } from './protocol';
import type { ImageAttachment } from './attachments';
import { buildUserContentWithImages } from './attachments';

const SYSTEM_PROMPT_BASE = [
	'Ты Haratsan - помощник программиста в VSCode.',
	'Отвечай по делу, на языке пользователя.',
	'Если в запросе есть контекст редактора (файл, выделение), опирайся на него.',
].join(' ');

function buildAskSystemPrompt(haratsanRulesAppendix?: string): string {
	const appendix = haratsanRulesAppendix?.trim();
	if (!appendix) {
		return SYSTEM_PROMPT_BASE;
	}

	return `${SYSTEM_PROMPT_BASE} ${appendix}`;
}

export async function buildChatCompletionMessages(
	messages: ChatUiMessage[],
	latestUserText: string,
	editorContext?: string,
	haratsanRulesAppendix?: string,
	attachments?: readonly ImageAttachment[],
): Promise<ChatMessage[]> {
	const prior = messages.filter((m): m is ChatUiMessage & { role: 'user' | 'assistant' } => (m.role === 'user' || m.role === 'assistant') && !m.toolCalls?.length && Boolean(m.content))
	.slice(0, -1)
	.map((m) => ({
		role: m.role,
		content: m.content,
	}));

	const userText = editorContext ? `${latestUserText}\n\n---\nКонтекст:\n${editorContext}` : latestUserText;
	const userContent: string | ChatContentPart[] = await buildUserContentWithImages(userText, attachments);

	return [
		{
			role: 'system',
			content: buildAskSystemPrompt(haratsanRulesAppendix),
		},
		...prior,
		{
			role: 'user',
			content: userContent,
		},
	];
}
