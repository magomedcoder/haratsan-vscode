import type { Memento } from 'vscode';
import type { ChatUiMessage } from './protocol';

const SESSIONS_KEY = 'haratsan.chat.sessions';
const CURRENT_ID_KEY = 'haratsan.chat.currentSessionId';
// Черновики Composer: sessionId * текст
const DRAFTS_KEY = 'haratsan.chat.drafts';
// Chips Composer: sessionId * insert-строки
const DRAFT_CHIPS_KEY = 'haratsan.chat.draftChips';

const MAX_SESSIONS = 40;
const MAX_STORED_MESSAGES = 80;

export interface StoredChatSession {
	id: string;
	title: string;
	messages: ChatUiMessage[];
	createdAt: number;
	updatedAt: number;
	// Parent<->child: вкладка субагента / handoff
	parentSessionId?: string;
	childSessionIds?: string[];
}

export interface SessionSummary {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	// Сейчас идёт agent/ask turn в этой вкладке (UI-индикатор)
	busy?: boolean;
	// Parent session (если эта вкладка - child субагента)
	parentSessionId?: string;
	// Child sessions, порождённые из этой вкладки
	childSessionIds?: string[];
	// Явный флаг child-сессии (дублирует parentSessionId для UI)
	isChild?: boolean;
}

function newId(): string {
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function slimMessages(messages: ChatUiMessage[]): ChatUiMessage[] {
	return messages.slice(-MAX_STORED_MESSAGES).map((msg) => {
		if (!msg.toolCalls?.length) {
			return msg;
		}

		return {
			...msg,
			toolCalls: msg.toolCalls.map((call) => {
				if (!call.hunks?.length) {
					return call;
				}

				return {
					...call,
					hunks: call.hunks.map((hunk) => {
						if (hunk.status === 'pending') {
							return hunk;
						}

						const { 
							oldLines: _o, 
							newLines: _n, 
							beforeContext: _b, 
							afterContext: _a, 
							...rest 
						} = hunk;
						return {
							...rest,
							oldLines: [],
							newLines: [],
						};
					}),
				};
			}),
		};
	});
}

function toSummary(session: StoredChatSession): SessionSummary {
	return {
		id: session.id,
		title: session.title,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		messageCount: session.messages.length,
		parentSessionId: session.parentSessionId,
		childSessionIds: session.childSessionIds?.length
			? [...session.childSessionIds]
			: undefined,
		isChild: Boolean(session.parentSessionId),
	};
}

// Заголовок новой сессии («Новый чат»)
export const DEFAULT_SESSION_TITLE = 'Новый чат';

export function isDefaultSessionTitle(title: string | undefined): boolean {
	return !title?.trim() || title.trim() === DEFAULT_SESSION_TITLE;
}

function defaultTitle(): string {
	return DEFAULT_SESSION_TITLE;
}

// Живой SessionStore для @past (mentions без ExtensionContext)
let sessionPeek: SessionStore | undefined;

export function setSessionPeek(store: SessionStore | undefined): void {
	sessionPeek = store;
}

export function getSessionPeek(): SessionStore | undefined {
	return sessionPeek;
}

// Persist нескольких чат-сессий в workspaceState (или переданный Memento)
export class SessionStore {
	private sessions: StoredChatSession[] = [];
	private currentId = '';
	// Черновики Composer в памяти + workspaceState
	private drafts: Record<string, string> = {};
	private draftChips: Record<string, string[]> = {};

	constructor(private readonly memento: Memento) {
		this.load();
	}

	private load(): void {
		const raw = this.memento.get<StoredChatSession[]>(SESSIONS_KEY);
		const current = this.memento.get<string>(CURRENT_ID_KEY, '');
		this.drafts = this.loadDraftsMap();
		this.draftChips = this.loadDraftChipsMap();

		if (Array.isArray(raw) && raw.length > 0) {
			this.sessions = raw.filter((s) => s && typeof s === 'object' && typeof s.id === 'string').map((s) => ({
				id: s.id,
				title: String(s.title || defaultTitle()).slice(0, 120),
				messages: Array.isArray(s.messages) ? s.messages : [],
				createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
				updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
			}));
			this.currentId = this.sessions.some((s) => s.id === current) ? current : this.sessions[0]!.id;
			return;
		}

		const now = Date.now();
		const empty: StoredChatSession = {
			id: newId(),
			title: defaultTitle(),
			messages: [],
			createdAt: now,
			updatedAt: now,
		};
		this.sessions = [empty];
		this.currentId = empty.id;
		void this.persistAll();
	}

	private loadDraftsMap(): Record<string, string> {
		const raw = this.memento.get<Record<string, string>>(DRAFTS_KEY);
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			return {};
		}

		const out: Record<string, string> = {};
		for (const [id, text] of Object.entries(raw)) {
			if (typeof text === 'string' && text.length > 0) {
				out[id] = text;
			}
		}

		return out;
	}

	private loadDraftChipsMap(): Record<string, string[]> {
		const raw = this.memento.get<Record<string, string[]>>(DRAFT_CHIPS_KEY);
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			return {};
		}

		const out: Record<string, string[]> = {};
		for (const [id, chips] of Object.entries(raw)) {
			if (!Array.isArray(chips)) {
				continue;
			}

			const cleaned = chips.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim());
			if (cleaned.length > 0) {
				out[id] = cleaned;
			}
		}

		return out;
	}

	private persistDrafts(): void {
		void this.memento.update(DRAFTS_KEY, this.drafts);
		void this.memento.update(DRAFT_CHIPS_KEY, this.draftChips);
	}

	private persistAll(): Thenable<void> {
		const trimmed = this.sessions.slice()
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, MAX_SESSIONS)
			.map((s) => ({
				...s,
				messages: slimMessages(s.messages),
			}));
		this.sessions = trimmed;
		if (!this.sessions.some((s) => s.id === this.currentId) && this.sessions[0]) {
			this.currentId = this.sessions[0].id;
		}

		return this.memento.update(SESSIONS_KEY, this.sessions).then(() =>
			this.memento.update(CURRENT_ID_KEY, this.currentId),
		);
	}

	listSessions(): SessionSummary[] {
		return this.sessions.slice()
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map(toSummary);
	}

	getCurrentSessionId(): string {
		return this.currentId;
	}

	// Черновик Composer для сессии (пустая строка если нет)
	getDraft(sessionId?: string): string {
		const id = sessionId ?? this.currentId;
		return this.drafts[id] ?? '';
	}

	// Chips Composer (insert-строки) для сессии
	getDraftChips(sessionId?: string): string[] {
		const id = sessionId ?? this.currentId;
		return this.draftChips[id] ? [...this.draftChips[id]!] : [];
	}

	// Сохранить черновик текущей (или указанной) сессии. Без emit - только persist
	setDraft(text: string, chips?: string[], sessionId?: string): void {
		const id = sessionId ?? this.currentId;
		if (!id) {
			return;
		}

		// Игнор черновика для неизвестной/удалённой сессии
		if (!this.getSession(id) && id !== this.currentId) {
			return;
		}

		const trimmed = text;
		let changed = false;
		if (trimmed.length === 0) {
			if (id in this.drafts) {
				delete this.drafts[id];
				changed = true;
			}
		} else if (this.drafts[id] !== trimmed) {
			this.drafts[id] = trimmed;
			changed = true;
		}

		if (chips !== undefined) {
			const nextChips = chips.filter((c) => typeof c === 'string' && c.trim().length > 0)
				.map((c) => c.trim());
			const prevChips = this.draftChips[id] ?? [];
			const chipsSame = prevChips.length === nextChips.length && prevChips.every((c, i) => c === nextChips[i]);
			if (nextChips.length === 0) {
				if (id in this.draftChips) {
					delete this.draftChips[id];
					changed = true;
				}
			} else if (!chipsSame) {
				this.draftChips[id] = nextChips;
				changed = true;
			}
		}

		if (changed) {
			this.persistDrafts();
		}
	}

	// Очистить черновик сессии
	clearDraft(sessionId?: string): void {
		const id = sessionId ?? this.currentId;
		if (!id) {
			return;
		}

		let changed = false;
		if (id in this.drafts) {
			delete this.drafts[id];
			changed = true;
		}

		if (id in this.draftChips) {
			delete this.draftChips[id];
			changed = true;
		}

		if (changed) {
			this.persistDrafts();
		}
	}

	getSession(id: string): StoredChatSession | undefined {
		return this.sessions.find((s) => s.id === id);
	}

	getCurrent(): StoredChatSession {
		const cur = this.getSession(this.currentId);
		if (cur) {
			return cur;
		}

		const created = this.createSession();
		return created;
	}

	// Сохранить сообщения текущей (или указанной) сессии
	saveMessages(messages: ChatUiMessage[], sessionId?: string): void {
		const id = sessionId ?? this.currentId;
		const idx = this.sessions.findIndex((s) => s.id === id);
		if (idx < 0) {
			return;
		}

		const prev = this.sessions[idx]!;
		// Title «Новый чат» оставляем - LLM-title (systemAgents) или renameSession обновят после хода
		this.sessions[idx] = {
			...prev,
			messages: slimMessages(messages),
			updatedAt: Date.now(),
		};
		void this.persistAll();
	}

	createSession(title?: string, opts?: { parentSessionId?: string }): StoredChatSession {
		const now = Date.now();
		const parentSessionId = opts?.parentSessionId?.trim() || undefined;
		const session: StoredChatSession = {
			id: newId(),
			title: (title?.trim() || defaultTitle()).slice(0, 120),
			messages: [],
			createdAt: now,
			updatedAt: now,
			parentSessionId,
		};
		this.sessions.unshift(session);
		if (parentSessionId) {
			this.linkChildSession(parentSessionId, session.id);
		}
		this.currentId = session.id;
		void this.persistAll();
		return session;
	}

	// Связать parent <-> child без смены currentId
	linkChildSession(parentId: string, childId: string): void {
		const pIdx = this.sessions.findIndex((s) => s.id === parentId);
		const cIdx = this.sessions.findIndex((s) => s.id === childId);
		if (pIdx < 0 || cIdx < 0) {
			return;
		}

		const parent = this.sessions[pIdx]!;
		const child = this.sessions[cIdx]!;
		const kids = new Set(parent.childSessionIds ?? []);
		kids.add(childId);
		this.sessions[pIdx] = {
			...parent,
			childSessionIds: [...kids],
			updatedAt: Date.now(),
		};
		this.sessions[cIdx] = {
			...child,
			parentSessionId: parentId,
			updatedAt: Date.now(),
		};
		void this.persistAll();
	}

	switchSession(id: string): StoredChatSession | undefined {
		const session = this.getSession(id);
		if (!session) {
			return undefined;
		}

		this.currentId = id;
		void this.memento.update(CURRENT_ID_KEY, this.currentId);
		return session;
	}

	renameSession(id: string, title: string): boolean {
		const trimmed = title.trim().slice(0, 120);
		if (!trimmed) {
			return false;
		}

		const idx = this.sessions.findIndex((s) => s.id === id);
		if (idx < 0) {
			return false;
		}

		this.sessions[idx] = {
			...this.sessions[idx]!,
			title: trimmed,
			updatedAt: Date.now(),
		};
		void this.persistAll();
		return true;
	}

	deleteSession(id: string): boolean {
		if (this.sessions.length <= 1) {
			// Последнюю сессию не удаляем - очищаем сообщения
			const only = this.sessions[0];
			if (!only || only.id !== id) {
				return false;
			}

			this.sessions[0] = {
				...only,
				title: defaultTitle(),
				messages: [],
				updatedAt: Date.now(),
			};
			this.currentId = only.id;
			this.clearDraft(id);
			void this.persistAll();
			return true;
		}

		const next = this.sessions.filter((s) => s.id !== id);
		if (next.length === this.sessions.length) {
			return false;
		}

		this.sessions = next;
		if (this.currentId === id) {
			this.currentId = this.sessions[0]!.id;
		}
		this.clearDraft(id);
		void this.persistAll();
		return true;
	}

	// Новая сессия с копией сообщений до messageId включительно.
	forkFromMessage(sourceId: string, messageId: string, title?: string): StoredChatSession | undefined {
		const source = this.getSession(sourceId);
		if (!source) {
			return undefined;
		}

		const idx = source.messages.findIndex((m) => m.id === messageId);
		if (idx < 0) {
			return undefined;
		}

		const copied = source.messages.slice(0, idx + 1).map((m) => structuredClone(m));
		const now = Date.now();
		const session: StoredChatSession = {
			id: newId(),
			title: (title?.trim() || source.title).slice(0, 120),
			messages: slimMessages(copied),
			createdAt: now,
			updatedAt: now,
		};
		this.sessions.unshift(session);
		this.currentId = session.id;
		void this.persistAll();
		return session;
	}
}

function titleFromMessages(messages: ChatUiMessage[]): string {
	const firstUser = messages.find((m) => m.role === 'user' && m.content.trim());
	if (!firstUser) {
		return DEFAULT_SESSION_TITLE;
	}

	const line = firstUser.content.trim().split(/\r?\n/)[0] ?? '';
	const cleaned = line.replace(/^\/\w+\s*/, '').trim();
	if (!cleaned) {
		return DEFAULT_SESSION_TITLE;
	}

	return cleaned.length > 48 ? `${cleaned.slice(0, 45)}...` : cleaned;
}

// Fallback-title из первого user-сообщения (если smallModel недоступен)
export function fallbackTitleFromMessages(messages: ChatUiMessage[]): string {
	return titleFromMessages(messages);
}
