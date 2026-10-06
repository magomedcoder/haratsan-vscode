import { getCommentStyleConfig, resolveCommentStyleId } from './styles';
import { stripByStyle } from './stripByStyle';

export type { CommentStyleConfig, CommentStyleId } from './types';
export { COMMENT_STYLES, getCommentStyleConfig, resolveCommentStyleId } from './styles';
export { stripByStyle } from './stripByStyle';

// Удаляет комментарии с учётом languageId (VSCode) через семейства синтаксиса
export function stripComments(source: string, languageId: string): string {
	const style = getCommentStyleConfig(languageId);
	return stripByStyle(source, style);
}
