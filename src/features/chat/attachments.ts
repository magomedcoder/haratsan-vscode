import * as vscode from 'vscode';
import { getSettings } from '../../core/config/settings';
import type { ChatContentPart } from '../../core/llm/types';

export interface IncomingImage {
	name: string;
	mimeType: string;
	base64: string;
}

export interface ImageAttachment {
	// Относительный путь в workspace, например `.haratsan/attachments/...`
	path: string;
	mimeType: string;
}

function sanitizeFileName(name: string): string {
	const base = name.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'image';
	return base.slice(0, 80);
}

function extForMime(mime: string): string {
	const m = mime.toLowerCase();
	if (m.includes('png')) {
		return 'png';
	}

	if (m.includes('jpeg') || m.includes('jpg')) {
		return 'jpg';
	}

	if (m.includes('gif')) {
		return 'gif';
	}

	if (m.includes('webp')) {
		return 'webp';
	}

	return 'png';
}

// Сохранить картинки в `.haratsan/attachments/` и вернуть метаданные
export async function saveImageAttachments(images: readonly IncomingImage[]): Promise<ImageAttachment[]> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder || images.length === 0) {
		return [];
	}

	const dir = vscode.Uri.joinPath(folder.uri, '.haratsan', 'attachments');
	try {
		await vscode.workspace.fs.stat(dir);
	} catch {
		await vscode.workspace.fs.createDirectory(dir);
	}

	const out: ImageAttachment[] = [];
	const stamp = Date.now();

	for (let i = 0; i < images.length; i += 1) {
		const img = images[i]!;
		const mime = (img.mimeType || 'image/png').split(';')[0]!.trim() || 'image/png';
		const ext = extForMime(mime);
		const safe = sanitizeFileName(img.name.replace(/\.[^.]+$/, '') || 'image');
		const fileName = `${stamp}-${i}-${safe}.${ext}`;
		const uri = vscode.Uri.joinPath(dir, fileName);
		const raw = Buffer.from(img.base64, 'base64');
		await vscode.workspace.fs.writeFile(uri, raw);
		out.push({
			path: `.haratsan/attachments/${fileName}`,
			mimeType: mime,
		});
	}

	return out;
}

// Вставить маркеры `[image path]` в текст пользователя
export function injectImagePathMarkers(text: string, attachments: readonly ImageAttachment[]): string {
	if (attachments.length === 0) {
		return text;
	}

	const markers = attachments.map((a) => `[image ${a.path}]`).join('\n');
	const trimmed = text.trim();
	return trimmed ? `${trimmed}\n\n${markers}` : markers;
}

// Собрать multimodal content для vision-модели (OpenAI-compatible image_url)
export async function buildUserContentWithImages(
	text: string,
	attachments: readonly ImageAttachment[] | undefined,
): Promise<string | ChatContentPart[]> {
	const settings = getSettings();
	if (!settings.visionEnabled || !attachments?.length) {
		return text;
	}

	let textBody = text;
	const imageParts: ChatContentPart[] = [];
	// autoResize делается в webview (Composer + ImageBitmap); host только режет по maxBase64
	const maxB64 = settings.attachmentImageMaxBase64;
	const folder = vscode.workspace.workspaceFolders?.[0];

	for (const att of attachments) {
		if (!folder) {
			break;
		}

		try {
			const uri = vscode.Uri.joinPath(folder.uri, ...att.path.split('/'));
			const bytes = await vscode.workspace.fs.readFile(uri);
			const b64 = Buffer.from(bytes).toString('base64');
			if (b64.length > maxB64) {
				textBody += `\n\n[image ${att.path}: base64 слишком большой (${b64.length} > ${maxB64}), только путь]`;
				continue;
			}

			const mime = att.mimeType || 'image/png';
			imageParts.push({
				type: 'image_url',
				image_url: { 
					url: `data:${mime};base64,${b64}` 
				},
			});
		} catch {
			textBody += `\n\n[image ${att.path}: не удалось прочитать]`;
		}
	}

	if (imageParts.length === 0) {
		return textBody;
	}

	return [{ 
		type: 'text', 
		text: textBody 
	}, ...imageParts];
}
