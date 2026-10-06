import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getSettings } from '../../../../core/config/settings';
import { type IncomingImage, saveImageAttachments } from '../../../chat/attachments';
import { AGENT_LIMITS, looksBinary, previewText } from '../../policy';
import { asOptionalInt, asString, type ToolContext, type ToolDefinition, type ToolResult } from '../../types';
import { resolveWorkspacePath, throwIfAborted } from '../../workspacePath';

const IMAGE_EXT_MIME: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
};

// Макс. страниц PDF, рендерящихся в PNG для vision (poppler pdftoppm)
const PDF_VISION_MAX_PAGES = 3;

function isPdfPath(relative: string): boolean {
	return relative.toLowerCase().endsWith('.pdf');
}

// MIME по расширению (.png/.jpg/.jpeg/.gif/.webp) - до looksBinary reject
function imageMimeFromPath(relative: string): string | undefined {
	const lower = relative.toLowerCase();
	const dot = lower.lastIndexOf('.');
	if (dot < 0) {
		return undefined;
	}

	return IMAGE_EXT_MIME[lower.slice(dot)];
}

function runPdftotext(fsPath: string, signal?: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; missing: boolean; error: string }> {
	return new Promise((resolve) => {
		const child = spawn('pdftotext', ['-layout', fsPath, '-'], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		const onAbort = () => {
			child.kill('SIGTERM');
		};
		signal?.addEventListener('abort', onAbort, { once: true });

		child.stdout.on('data', (d) => {
			stdout += String(d);
		});
		child.stderr.on('data', (d) => {
			stderr += String(d);
		});
		child.on('error', (err) => {
			signal?.removeEventListener('abort', onAbort);
			const msg = err instanceof Error ? err.message : String(err);
			const missing = (err as NodeJS.ErrnoException).code === 'ENOENT' || /ENOENT|not found/i.test(msg);
			resolve({
				ok: false,
				missing,
				error: msg,
			});
		});
		child.on('close', (code) => {
			signal?.removeEventListener('abort', onAbort);
			if (code === 0) {
				resolve({
					ok: true,
					text: stdout,
				});
				return;
			}
			resolve({
				ok: false,
				missing: false,
				error: stderr.trim() || `pdftotext exit ${code ?? '?'}`,
			});
		});
	});
}

// Конвертация страниц PDF 1..maxPages в PNG через pdftoppm
function runPdftoppmPages(
	fsPath: string,
	outPrefix: string,
	maxPages: number,
	signal?: AbortSignal,
): Promise<{ ok: true; pngPaths: string[] } | { ok: false; missing: boolean; error: string }> {
	const pages = Math.max(1, Math.min(5, Math.floor(maxPages)));
	return new Promise((resolve) => {
		const child = spawn(
			'pdftoppm',
			['-png', '-f', '1', '-l', String(pages), '-r', '120', fsPath, outPrefix],
			{ stdio: ['ignore', 'pipe', 'pipe'] },
		);
		let stderr = '';
		const onAbort = () => {
			child.kill('SIGTERM');
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		child.stderr.on('data', (d) => {
			stderr += String(d);
		});
		child.on('error', (err) => {
			signal?.removeEventListener('abort', onAbort);
			const msg = err instanceof Error ? err.message : String(err);
			const missing = (err as NodeJS.ErrnoException).code === 'ENOENT' || /ENOENT|not found/i.test(msg);
			resolve({ ok: false, missing, error: msg });
		});
		child.on('close', (code) => {
			void (async () => {
				signal?.removeEventListener('abort', onAbort);
				if (code !== 0) {
					resolve({
						ok: false,
						missing: false,
						error: stderr.trim() || `pdftoppm exit ${code ?? '?'}`,
					});
					return;
				}
				const pngPaths: string[] = [];
				for (let i = 1; i <= pages; i += 1) {
					const candidate = `${outPrefix}-${i}.png`;
					try {
						await fs.access(candidate);
						pngPaths.push(candidate);
					} catch {
						if (i === 1) {
							const single = `${outPrefix}.png`;
							try {
								await fs.access(single);
								pngPaths.push(single);
							} catch {}
						}
					}
				}
				if (pngPaths.length === 0) {
					resolve({
						ok: false,
						missing: false,
						error: stderr.trim() || 'pdftoppm produced no PNG files',
					});
					return;
				}
				resolve({ ok: true, pngPaths });
			})();
		});
	});
}

async function maybePdfVisionAttachment(
	pdfFsPath: string,
	relative: string,
	signal?: AbortSignal,
): Promise<{ attachments?: ToolResult['attachments']; note: string }> {
	const settings = getSettings();
	if (!settings.visionEnabled) {
		return {
			note: `visionEnabled=false - только текст (pdftotext). Включи vision для страниц PNG (до ${PDF_VISION_MAX_PAGES}).`,
		};
	}

	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-pdf-'));
	const prefix = path.join(tmpDir, 'page');
	try {
		const rendered = await runPdftoppmPages(pdfFsPath, prefix, PDF_VISION_MAX_PAGES, signal);
		if (!rendered.ok) {
			if (rendered.missing) {
				return {
					note: 'pdftoppm недоступен - текст-only. Установи poppler-utils для multimodal PDF (страницы -> PNG).',
				};
			}
			return { note: `pdftoppm failed: ${rendered.error} - текст-only` };
		}

		const incoming: IncomingImage[] = [];
		const baseName = path.basename(relative, path.extname(relative)) || 'pdf';
		for (let i = 0; i < rendered.pngPaths.length; i += 1) {
			const pngPath = rendered.pngPaths[i]!;
			const raw = await fs.readFile(pngPath);
			const base64 = raw.toString('base64');
			if (base64.length > settings.attachmentImageMaxBase64) {
				continue;
			}
			incoming.push({
				name: `${baseName}-page${i + 1}.png`,
				mimeType: 'image/png',
				base64,
			});
		}
		if (incoming.length === 0) {
			return {
				note: 'PDF page PNGs too large for vision - текст-only',
			};
		}

		const saved = await saveImageAttachments(incoming);
		if (saved.length === 0) {
			return { note: 'PDF page PNG rendered but attachment save failed - текст-only' };
		}
		return {
			attachments: saved,
			note: `PDF multimodal: text + ${saved.length} page PNG(s) -> ${saved.map((s) => s.path).join(', ')}`,
		};
	} catch (err) {
		return {
			note: `PDF vision skip: ${err instanceof Error ? err.message : String(err)}`,
		};
	} finally {
		try {
			await fs.rm(tmpDir, { 
				recursive: true, 
				force: true 
			});
		} catch {}
	}
}

async function readPdfText(
	resolved: { uri: vscode.Uri; relative: string; fsPath?: string },
	signal?: AbortSignal,
): Promise<ToolResult> {
	const fsPath = resolved.uri.fsPath;
	const extracted = await runPdftotext(fsPath, signal);
	if (extracted.ok) {
		const text = extracted.text.trim();
		if (!text) {
			return {
				ok: false,
				content: vscode.l10n.t('tool.pdfEmpty', resolved.relative),
			};
		}

		const vision = await maybePdfVisionAttachment(fsPath, resolved.relative, signal);
		const header = `${vscode.l10n.t('tool.pdfHeader', resolved.relative)}\n[${vision.note}]\n`;
		return {
			ok: true,
			content: previewText(`${header}${text}`, AGENT_LIMITS.maxReadBytes),
			attachments: vision.attachments,
			path: resolved.relative,
		};
	}

	if (extracted.missing) {
		return {
			ok: false,
			content: vscode.l10n.t('tool.pdfNeedPoppler', resolved.relative),
		};
	}

	return {
		ok: false,
		content: vscode.l10n.t('tool.pdfExtractFailed', resolved.relative, extracted.error),
	};
}

// Прочитать картинку * `.haratsan/attachments` + attachments для vision-цикла агента
async function readImageFile(
	resolved: {
		uri: vscode.Uri;
		relative: string;
	},
	mimeType: string,
): Promise<ToolResult> {
	const settings = getSettings();
	if (!settings.visionEnabled) {
		return {
			ok: false,
			content: vscode.l10n.t('tool.imageVisionDisabled', resolved.relative),
		};
	}

	let raw: Uint8Array;
	try {
		raw = await vscode.workspace.fs.readFile(resolved.uri);
	} catch {
		return {
			ok: false,
			content: vscode.l10n.t('tool.fileNotFound', resolved.relative),
		};
	}

	const base64 = Buffer.from(raw).toString('base64');
	const maxB64 = settings.attachmentImageMaxBase64;
	if (base64.length > maxB64) {
		return {
			ok: false,
			content: vscode.l10n.t('tool.imageTooLarge', resolved.relative, base64.length, maxB64),
		};
	}

	const name = resolved.relative.split(/[/\\]/).pop() || 'image';
	const saved = await saveImageAttachments([
		{
			name,
			mimeType,
			base64,
		},
	]);
	if (saved.length === 0) {
		return {
			ok: false,
			content: vscode.l10n.t('tool.imageSaveFailed', resolved.relative),
		};
	}

	const att = saved[0]!;
	return {
		ok: true,
		content: vscode.l10n.t('tool.imageSaved', att.path),
		path: resolved.relative,
		attachments: saved,
	};
}

export const readFileTool: ToolDefinition = {
	name: 'read_file',
	description: 'Прочитать текстовый файл из workspace (или PDF: pdftotext + до 3 страниц PNG через pdftoppm при visionEnabled; картинки .png/.jpg/.gif/.webp - через vision). Можно указать диапазон строк (1-based, включительно) для текста.',
	parameters: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Путь к файлу',
			},
			start_line: {
				type: 'integer',
				description: 'Первая строка (с 1)',
			},
			end_line: {
				type: 'integer',
				description: 'Последняя строка (включительно)',
			},
		},
		required: ['path'],
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const resolved = await resolveWorkspacePath(asString(args, 'path'));

		if (isPdfPath(resolved.relative)) {
			return readPdfText(resolved, ctx.signal);
		}

		const imageMime = imageMimeFromPath(resolved.relative);
		if (imageMime) {
			return readImageFile(resolved, imageMime);
		}

		let raw: Uint8Array;
		try {
			raw = await vscode.workspace.fs.readFile(resolved.uri);
		} catch {
			return {
				ok: false,
				content: vscode.l10n.t('tool.fileNotFound', resolved.relative),
			};
		}

		if (looksBinary(raw)) {
			return {
				ok: false,
				content: vscode.l10n.t('tool.binaryFile', resolved.relative),
			};
		}

		if (raw.byteLength > AGENT_LIMITS.maxReadBytes) {
			return {
				ok: false,
				content: vscode.l10n.t('tool.fileTooLarge', raw.byteLength, AGENT_LIMITS.maxReadBytes),
			};
		}

		const text = new TextDecoder('utf8', { fatal: false }).decode(raw);
		const lines = text.split(/\r?\n/);
		const start = Math.max(1, asOptionalInt(args, 'start_line') ?? 1);
		const end = Math.min(lines.length, asOptionalInt(args, 'end_line') ?? lines.length);
		if (start > end) {
			return {
				ok: false,
				content: vscode.l10n.t('tool.badLineRange'),
			};
		}

		const numbered = lines.slice(start - 1, end).map((line, i) => `${String(start + i).padStart(6, ' ')}|${line}`);
		const body = numbered.join('\n');

		return {
			ok: true,
			content: previewText(
				`${vscode.l10n.t('tool.fileHeader', resolved.relative, start, end, lines.length)}\n${body}`,
				AGENT_LIMITS.maxReadBytes,
			),
		};
	},
};
