import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type SubmitEvent } from 'react';
import type { ChatMode, MentionSuggestion } from '../../features/chat/protocol';
import { activeSlashQuery, filterSlashCommands } from '../../features/chat/slashCommands';
import type { SlashCommand } from '../../features/chat/slashCommands';
import type { HaratsanSettings } from '../../core/config/types';
import { t } from '../i18n';
import { vscodeApi } from '../vscodeApi';

interface ComposerProps {
	busy: boolean;
	busyDetail?: string;
	queuedCount: number;
	mode: ChatMode;
	customSlashCommands?: SlashCommand[];
	// Id текущей сессии - смена сбрасывает локальный draft с хоста
	sessionId?: string;
	// Черновик с хоста (per-session)
	composerDraft?: string;
	// Chips (insert-строки) с хоста
	composerChips?: string[];
	// Лимиты resize картинок (из settings)
	imageResize?: Pick<HaratsanSettings, 'attachmentImageAutoResize' | 'attachmentImageMaxWidth' | 'attachmentImageMaxHeight'>;
}

interface ContextChip {
	id: string;
	kind: MentionSuggestion['kind'];
	label: string;
	insert: string;
}

type SuggestKind = 'mention' | 'slash';

function activeMentionQuery(text: string, cursor: number): { start: number; query: string } | undefined {
	const before = text.slice(0, cursor);
	const at = before.lastIndexOf('@');
	if (at < 0) {
		return undefined;
	}

	if (at > 0 && !/\s/.test(before[at - 1] ?? ' ')) {
		return undefined;
	}

	const fragment = before.slice(at + 1);
	if (/\s/.test(fragment) && !/^(file|folder|codebase|symbols|git|link|docs|agent|past|alias|ref)\s+\S*$/i.test(fragment)) {
		return undefined;
	}

	return { start: at, query: fragment };
}

interface PendingImage {
	id: string;
	name: string;
	mimeType: string;
	base64: string;
}

// Уменьшить картинку через createImageBitmap + canvas (без новых deps).
// Если ImageBitmap недоступен - вернуть исходный data URL как есть.
async function encodeImageFile(
	file: File,
	opts: {
		autoResize: boolean;
		maxWidth: number;
		maxHeight: number;
	},
): Promise<{ base64: string; mimeType: string } | undefined> {
	const mimeType = file.type || 'image/png';
	const readAsDataUrl = (): Promise<string> =>
		new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result ?? ''));
			reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
			reader.readAsDataURL(file);
		});

	const fromDataUrl = (dataUrl: string): { base64: string; mimeType: string } | undefined => {
		const comma = dataUrl.indexOf(',');
		const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
		if (!base64) {
			return undefined;
		}

		return { base64, mimeType };
	};

	if (!opts.autoResize || typeof createImageBitmap !== 'function') {
		return fromDataUrl(await readAsDataUrl());
	}

	try {
		const bitmap = await createImageBitmap(file);
		const scale = Math.min(1, opts.maxWidth / bitmap.width, opts.maxHeight / bitmap.height);
		if (scale >= 1) {
			bitmap.close();
			return fromDataUrl(await readAsDataUrl());
		}

		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			bitmap.close();
			return fromDataUrl(await readAsDataUrl());
		}

		ctx.drawImage(bitmap, 0, 0, width, height);
		bitmap.close();
		const outMime = mimeType.includes('jpeg') || mimeType.includes('jpg')
			? 'image/jpeg'
			: mimeType.includes('webp')
				? 'image/webp'
				: 'image/png';
		const dataUrl = outMime === 'image/jpeg'
			? canvas.toDataURL(outMime, 0.92)
			: canvas.toDataURL(outMime);
		const parsed = fromDataUrl(dataUrl);
		return parsed ? { 
			...parsed, 
			mimeType: outMime 
		} : undefined;
	} catch {
		return fromDataUrl(await readAsDataUrl());
	}
}

function chipFromSuggestion(item: MentionSuggestion): ContextChip {
	return {
		id: item.insert.trim(),
		kind: item.kind,
		label: item.label,
		insert: item.insert.trim(),
	};
}

const MENTION_KINDS = new Set<MentionSuggestion['kind']>(['file', 'folder', 'codebase', 'map', 'symbols', 'code', 'git', 'branch_diff', 'rules', 'link', 'docs', 'agent', 'terminals', 'past', 'alias', 'ref']);

// Восстановить chip из сохранённой insert-строки (@file path ...)
function chipFromInsert(insert: string): ContextChip {
	const trimmed = insert.trim();
	const m = /^@(\w+)/i.exec(trimmed);
	const rawKind = (m?.[1] ?? 'file').toLowerCase().replace(/-/g, '_') as MentionSuggestion['kind'];
	const kind = MENTION_KINDS.has(rawKind) ? rawKind : 'file';
	let arg = trimmed.replace(/^@\w+/i, '').replace(/^[:\s]+/, '').trim();
	if (arg.length >= 2) {
		const a = arg[0];
		const b = arg[arg.length - 1];
		if ((a === '"' && b === '"') || (a === "'" && b === "'") || (a === '`' && b === '`')) {
			arg = arg.slice(1, -1).trim();
		}
	}
	const label = arg.split(/[/\\]/).filter(Boolean).pop() || trimmed;
	return {
		id: trimmed,
		kind,
		label,
		insert: trimmed,
	};
}

function quoteMentionPathArg(path: string): string {
	const p = path.trim();
	if (!/[\s@]/.test(p)) {
		return p;
	}

	if (!p.includes('"')) {
		return `"${p}"`;
	}

	if (!p.includes("'")) {
		return `'${p}'`;
	}

	return `\`${p.replace(/`/g, '')}\``;
}

function slashDetail(cmd: SlashCommand): string {
	if (cmd.detail) {
		return cmd.detail;
	}
	return cmd.detailKey ? t(cmd.detailKey) : '';
}

// Нормализация вставленного пути: кавычки, file://, слеши
function normalizePastedPath(raw: string): string {
	let path = raw.trim();
	if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) {
		path = path.slice(1, -1).trim();
	}

	if (/^file:\/\//i.test(path)) {
		try {
			path = decodeURIComponent(path.replace(/^file:\/\//i, ''));
			// file:///C:/... на Windows
			if (/^\/[A-Za-z]:\//.test(path)) {
				path = path.slice(1);
			}
		} catch {
			path = path.replace(/^file:\/\//i, '');
		}
	}

	return path.replace(/\\/g, '/');
}

// Эвристика: одна строка без переносов, похожа на путь к файлу (расширение и/или разделители пути). Ctrl+Shift+V обходит это
function looksLikeFilePath(text: string): string | undefined {
	if (!text || /[\r\n]/.test(text)) {
		return undefined;
	}

	const path = normalizePastedPath(text);
	if (!path) {
		return undefined;
	}

	// Не превращать URL / mailto в @file
	if (/^(https?:|mailto:|data:)/i.test(path)) {
		return undefined;
	}

	const hasSep = /[/\\]/.test(path) || /^[A-Za-z]:\//.test(path) || path.startsWith('~/') || path.startsWith('./') || path.startsWith('../');
	const hasExt = /\.[A-Za-z0-9]{1,12}$/.test(path);
	// Пути с пробелами ок - insert обернёт в кавычки (@file "a b.ts")
	if (!/^[\w./:@~+\-\s]+$/.test(path) && !/^[A-Za-z]:\/[\w./@~+\-\s]*$/.test(path)) {
		return undefined;
	}

	if (hasExt || hasSep) {
		return path;
	}

	return undefined;
}

export function Composer({
	busy,
	busyDetail,
	queuedCount,
	mode,
	customSlashCommands = [],
	sessionId,
	composerDraft,
	composerChips,
	imageResize,
}: ComposerProps) {
	const [draft, setDraft] = useState(() => composerDraft ?? '');
	const [chips, setChips] = useState<ContextChip[]>(() =>
		(composerChips ?? []).map(chipFromInsert),
	);
	const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
	const [suggestions, setSuggestions] = useState<MentionSuggestion[]>([]);
	const [slashSuggestions, setSlashSuggestions] = useState<SlashCommand[]>([]);
	const [suggestKind, setSuggestKind] = useState<SuggestKind>('mention');
	const [suggestIndex, setSuggestIndex] = useState(0);
	const requestId = useRef(0);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	// Ctrl/Meta+Shift+V - вставка без конвертации пути в pill
	const plainPasteRef = useRef(false);
	const draftTimerRef = useRef<number | undefined>(undefined);
	const draftRef = useRef(draft);
	const chipsRef = useRef(chips);
	const sessionIdRef = useRef(sessionId);
	draftRef.current = draft;
	chipsRef.current = chips;
	sessionIdRef.current = sessionId;

	const postDraft = (text: string, nextChips: ContextChip[], sid: string | undefined) => {
		vscodeApi.postMessage({
			type: 'setComposerDraft',
			text,
			chips: nextChips.map((c) => c.insert),
			sessionId: sid,
		});
	};

	const setMode = (next: ChatMode) => {
		if (next === mode || busy) {
			return;
		}

		vscodeApi.postMessage({
			type: 'setChatMode',
			mode: next,
		});
	};

	// Debounce persist; на unmount - flush, чтобы switch не терял последние символы
	useEffect(() => {
		if (draftTimerRef.current !== undefined) {
			window.clearTimeout(draftTimerRef.current);
		}
		draftTimerRef.current = window.setTimeout(() => {
			draftTimerRef.current = undefined;
			postDraft(draft, chips, sessionId);
		}, 300);
		return () => {
			if (draftTimerRef.current !== undefined) {
				window.clearTimeout(draftTimerRef.current);
				draftTimerRef.current = undefined;
			}
		};
	}, [draft, chips, sessionId]);

	useEffect(() => {
		return () => {
			postDraft(draftRef.current, chipsRef.current, sessionIdRef.current);
		};
	}, []);

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const data = event.data;
			if (!data || data.type !== 'mentionSuggestions') {
				return;
			}

			if (data.requestId !== requestId.current) {
				return;
			}

			setSuggestions(data.items ?? []);
			setSuggestKind('mention');
			setSuggestIndex(0);
		};

		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, []);

	const clearSuggest = () => {
		setSuggestions([]);
		setSlashSuggestions([]);
	};

	const requestSuggestions = (text: string, cursor: number) => {
		const slash = activeSlashQuery(text, cursor);
		if (slash) {
			const items = filterSlashCommands(slash.query, customSlashCommands);
			setSlashSuggestions(items);
			setSuggestions([]);
			setSuggestKind('slash');
			setSuggestIndex(0);
			return;
		}

		setSlashSuggestions([]);
		const active = activeMentionQuery(text, cursor);
		if (!active) {
			setSuggestions([]);
			return;
		}

		const id = requestId.current + 1;
		requestId.current = id;
		setSuggestKind('mention');
		vscodeApi.postMessage({
			type: 'mentionSuggest',
			requestId: id,
			query: active.query,
		});
	};

	const applyMentionSuggestion = (item: MentionSuggestion) => {
		const el = textareaRef.current;
		const cursor = el?.selectionStart ?? draft.length;
		const active = activeMentionQuery(draft, cursor);
		if (!active) {
			return;
		}

		const chip = chipFromSuggestion(item);
		setChips((prev) => (prev.some((c) => c.id === chip.id) ? prev : [...prev, chip]));

		const next = `${draft.slice(0, active.start)}${draft.slice(cursor)}`.replace(/\s{2,}/g, ' ');
		setDraft(next);
		clearSuggest();
		requestAnimationFrame(() => {
			el?.focus();
			el?.setSelectionRange(active.start, active.start);
		});
	};

	const applySlashSuggestion = (cmd: SlashCommand) => {
		// Если нужны args - пробел после имени, курсор готов к вводу
		const insert = cmd.needsArgs ? `/${cmd.name} ` : `/${cmd.name}`;
		setDraft(insert);
		clearSuggest();
		requestAnimationFrame(() => {
			const el = textareaRef.current;
			el?.focus();
			const pos = insert.length;
			el?.setSelectionRange(pos, pos);
		});
	};

	const removeChip = (id: string) => {
		setChips((prev) => prev.filter((c) => c.id !== id));
	};

	const removePendingImage = (id: string) => {
		setPendingImages((prev) => prev.filter((p) => p.id !== id));
	};

	const addImageFile = (file: File) => {
		if (!file.type.startsWith('image/')) {
			return;
		}

		void (async () => {
			const encoded = await encodeImageFile(file, {
				autoResize: imageResize?.attachmentImageAutoResize !== false,
				maxWidth: imageResize?.attachmentImageMaxWidth ?? 2048,
				maxHeight: imageResize?.attachmentImageMaxHeight ?? 2048,
			});
			if (!encoded) {
				return;
			}

			const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
			setPendingImages((prev) => [
				...prev,
				{
					id,
					name: file.name || 'image.png',
					mimeType: encoded.mimeType,
					base64: encoded.base64,
				},
			]);
		})();
	};

	const addFilePathChip = (path: string) => {
		const insert = `@file ${quoteMentionPathArg(path)}`;
		const chip: ContextChip = {
			id: insert,
			kind: 'file',
			label: path.split(/[/\\]/).filter(Boolean).pop() || path,
			insert,
		};
		setChips((prev) => (prev.some((c) => c.id === chip.id) ? prev : [...prev, chip]));
	};

	const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		const items = event.clipboardData?.items;
		if (!items) {
			return;
		}

		let handled = false;
		for (const item of Array.from(items)) {
			if (item.kind === 'file' && item.type.startsWith('image/')) {
				const file = item.getAsFile();
				if (file) {
					addImageFile(file);
					handled = true;
				}
			}
		}

		if (handled) {
			event.preventDefault();
			return;
		}

		// Ctrl/Meta+Shift+V - обычная вставка текста без конвертации в pill
		if (plainPasteRef.current) {
			plainPasteRef.current = false;
			return;
		}

		const text = event.clipboardData?.getData('text/plain') ?? '';
		const path = looksLikeFilePath(text);
		if (!path) {
			return;
		}

		event.preventDefault();
		addFilePathChip(path);
	};

	const onDrop = (event: DragEvent<HTMLTextAreaElement>) => {
		event.preventDefault();
		const files = event.dataTransfer?.files;
		if (!files?.length) {
			return;
		}
		
		for (const file of Array.from(files)) {
			addImageFile(file);
		}
	};

	const onDragOver = (event: DragEvent<HTMLTextAreaElement>) => {
		if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
			event.preventDefault();
		}
	};

	const submit = () => {
		const question = draft.trim();
		const prefix = chips.map((c) => c.insert).join(' ').trim();
		const text = [prefix, question].filter(Boolean).join(' ').trim();
		if (!text && pendingImages.length === 0) {
			return;
		}

		const images = pendingImages.map((p) => ({
			name: p.name,
			mimeType: p.mimeType,
			base64: p.base64,
		}));
		// Сразу очистить локально и сбросить pending debounce (host clear в send)
		if (draftTimerRef.current !== undefined) {
			window.clearTimeout(draftTimerRef.current);
			draftTimerRef.current = undefined;
		}
		draftRef.current = '';
		chipsRef.current = [];
		setDraft('');
		setChips([]);
		setPendingImages([]);
		clearSuggest();
		vscodeApi.postMessage({
			type: 'send',
			text,
			images: images.length ? images : undefined,
		});
	};

	const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
		event.preventDefault();
		submit();
	};

	const menuOpen = (suggestKind === 'mention' && suggestions.length > 0) || (suggestKind === 'slash' && slashSuggestions.length > 0);
	const menuLen = suggestKind === 'slash' ? slashSuggestions.length : suggestions.length;

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === 'v' && event.shiftKey && (event.ctrlKey || event.metaKey)) {
			plainPasteRef.current = true;
			// Сброс после paste (paste идёт после keydown в том же жесте)
			window.setTimeout(() => {
				plainPasteRef.current = false;
			}, 0);
		}

		if (menuOpen) {
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				setSuggestIndex((i) => (i + 1) % menuLen);
				return;
			}

			if (event.key === 'ArrowUp') {
				event.preventDefault();
				setSuggestIndex((i) => (i - 1 + menuLen) % menuLen);
				return;
			}

			if (event.key === 'Enter' || event.key === 'Tab') {
				event.preventDefault();
				if (suggestKind === 'slash') {
					applySlashSuggestion(slashSuggestions[suggestIndex] ?? slashSuggestions[0]!);
				} else {
					applyMentionSuggestion(suggestions[suggestIndex] ?? suggestions[0]!);
				}
				return;
			}

			if (event.key === 'Escape') {
				event.preventDefault();
				clearSuggest();
				return;
			}
		}

		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			submit();
			return;
		}

		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	};

	const canSend = Boolean(draft.trim()) || chips.length > 0 || pendingImages.length > 0;
	const specialMode = mode === 'debug' || mode === 'design' || mode === 'plan' || mode === 'multitask' || mode === 'project';

	return (
		<form className="composer" onSubmit={onSubmit}>
			<div className="composer__box">
				{suggestKind === 'slash' && slashSuggestions.length > 0 ? (
					<ul className="mention-menu" role="listbox" aria-label={t('chat.composer.slashAria')}>
						{slashSuggestions.map((item, i) => (
							<li key={item.name}>
								<button
									type="button"
									className={`mention-menu__item${i === suggestIndex ? ' mention-menu__item--active' : ''}`}
									onMouseDown={(e) => {
										e.preventDefault();
										applySlashSuggestion(item);
									}}
								>
									<span className="mention-menu__label">/{item.name}</span>
									<span className="mention-menu__detail">{slashDetail(item)}</span>
								</button>
							</li>
						))}
					</ul>
				) : null}
				{suggestKind === 'mention' && suggestions.length > 0 ? (
					<ul className="mention-menu" role="listbox">
						{suggestions.map((item, i) => (
							<li key={`${item.insert}-${i}`}>
								<button
									type="button"
									className={`mention-menu__item${i === suggestIndex ? ' mention-menu__item--active' : ''}`}
									onMouseDown={(e) => {
										e.preventDefault();
										applyMentionSuggestion(item);
									}}
								>
									<span className="mention-menu__main">
										<span className="mention-menu__label">{item.label}</span>
									</span>
									{item.detail ? <span className="mention-menu__detail">{item.detail}</span> : null}
								</button>
							</li>
						))}
					</ul>
				) : null}
				{chips.length > 0 ? (
					<ul className="composer-chips" aria-label={t('chat.composer.chipsAria')}>
						{chips.map((chip) => (
							<li key={chip.id} className={`composer-chip composer-chip--${chip.kind}`}>
								<span className="composer-chip__kind">@{chip.kind}</span>
								<span className="composer-chip__label" title={chip.label}>{chip.label}</span>
								<button
									type="button"
									className="composer-chip__remove"
									aria-label={t('chat.composer.removeChip', chip.label)}
									onClick={() => removeChip(chip.id)}
								>
									*
								</button>
							</li>
						))}
					</ul>
				) : null}
				{pendingImages.length > 0 ? (
					<ul className="composer-chips" aria-label={t('chat.composer.imagesAria')}>
						{pendingImages.map((img) => (
							<li key={img.id} className="composer-chip composer-chip--image">
								<span className="composer-chip__kind">img</span>
								<span className="composer-chip__label" title={img.name}>{img.name}</span>
								<button
									type="button"
									className="composer-chip__remove"
									aria-label={t('chat.composer.removeChip', img.name)}
									onClick={() => removePendingImage(img.id)}
								>
									*
								</button>
							</li>
						))}
					</ul>
				) : null}
				{busyDetail ? (
					<div className="composer-queue composer-queue--retry" role="status">
						{busyDetail}
					</div>
				) : null}
				{queuedCount > 0 ? (
					<div className="composer-queue" role="status">
						{t('chat.composer.queued', queuedCount)}
					</div>
				) : null}
				<textarea
					ref={textareaRef}
					className="composer__input"
					rows={2}
					value={draft}
					placeholder={
						busy
							? t('chat.composer.placeholderBusy')
							: mode === 'project'
								? t('chat.composer.placeholderProject')
								: t('chat.composer.placeholder')
					}
					onChange={(e) => {
						const next = e.target.value;
						setDraft(next);
						requestSuggestions(next, e.target.selectionStart);
					}}
					onKeyUp={(e) => {
						const target = e.currentTarget;
						requestSuggestions(target.value, target.selectionStart);
					}}
					onClick={(e) => {
						const target = e.currentTarget;
						requestSuggestions(target.value, target.selectionStart);
					}}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					onDrop={onDrop}
					onDragOver={onDragOver}
				/>
				<div className="composer__footer">
					<div className="composer__modes">
						<div className="mode-toggle" role="group" aria-label={t('chat.composer.modeAria')}>
							<button
								type="button"
								className={`mode-toggle__btn${mode === 'ask' ? ' mode-toggle__btn--active' : ''}`}
								disabled={busy}
								onClick={() => setMode('ask')}
							>
								{t('chat.composer.modeAsk')}
							</button>
							<button
								type="button"
								className={`mode-toggle__btn${mode === 'agent' ? ' mode-toggle__btn--active' : ''}`}
								disabled={busy}
								onClick={() => setMode('agent')}
							>
								{t('chat.composer.modeAgent')}
							</button>
						</div>
						{specialMode ? (
							<button
								type="button"
								className={`mode-badge${mode === 'project' ? ' mode-badge--project' : ''}`}
								disabled={busy}
								title={mode === 'project' ? t('chat.composer.modeBadge.projectHint') : t('chat.composer.slashExitHint')}
								onClick={() => setMode('agent')}
							>
								{mode === 'project' ? t('chat.composer.modeBadge.project') : `/${mode}`}
							</button>
						) : null}
					</div>
					<div className="composer__actions">
						{busy ? (
							<button
								className="btn btn--secondary composer__btn"
								type="button"
								onClick={() => vscodeApi.postMessage({ type: 'cancel' })}
							>
								{t('chat.composer.stop')}
							</button>
						) : null}
						<button
							className="btn composer__btn"
							type="submit"
							disabled={!canSend}
						>
							{busy ? t('chat.composer.queue') : t('chat.composer.send')}
						</button>
					</div>
				</div>
			</div>
		</form>
	);
}
