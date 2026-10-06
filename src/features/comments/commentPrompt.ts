import type { CommentStyle } from '../../core/config/settings';
import type { ChatMessage } from '../../core/llm/types';
import { getHaratsanRulesManager } from '../project/haratsanRules';
import { formatFewShotUser, pickFewShot } from './commentFewShot';

export interface CommentPromptInput {
	languageId: string;
	fileName: string;
	code: string;
	commentStyle: CommentStyle;
	commentSystemPrompt: string;
}

const STYLE_HINT: Record<CommentStyle, string> = {
	inline: 'Предпочти короткие строковые комментарии (// или #) над неочевидными строками.',
	block: 'Предпочти короткие блочные комментарии над неочевидными участками.',
};

function buildSystemPrompt(input: CommentPromptInput): string {
	const parts = [
		'Ты senior-разработчик: добавляешь только полезные комментарии к коду.',
		'Пиши комментарии на русском языке.',
		STYLE_HINT[input.commentStyle],
		'Не описывай очевидное (инкременты, простые геттеры, тривиальные присваивания).',
		'Комментируй инварианты, побочные эффекты, причины решений и edge cases.',
		'Не рефактори, не переименовывай, не переформатируй, не удаляй и не меняй исполняемый код.',
		'Сохраняй отступы и форматирование как есть.',
		'Ответь ТОЛЬКО полным прокомментированным кодом. Без markdown-ограждений, если их не было в исходнике. Без пояснений вне кода.',
	];

	if (input.commentSystemPrompt.trim()) {
		parts.push(input.commentSystemPrompt.trim());
	}

	const haratsanRules = getHaratsanRulesManager()?.getPromptAppendix();
	if (haratsanRules) {
		parts.push(haratsanRules);
	}

	return parts.join(' ');
}

export function buildCommentMessages(input: CommentPromptInput): ChatMessage[] {
	const fewShot = pickFewShot(input.languageId);

	const user = [
		`Язык: ${input.languageId}`,
		`Файл: ${input.fileName}`,
		'Добавь комментарии к коду. Верни только прокомментированный код:',
		`\`\`\`${input.languageId}`,
		input.code,
		'```',
	].join('\n');

	return [
		{
			role: 'system',
			content: buildSystemPrompt(input),
		},
		{
			role: 'user',
			content: formatFewShotUser(fewShot),
		},
		{
			role: 'assistant',
			content: fewShot.assistantCode,
		},
		{
			role: 'user',
			content: user,
		},
	];
}
