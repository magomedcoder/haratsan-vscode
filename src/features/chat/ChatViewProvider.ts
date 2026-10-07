import * as vscode from 'vscode';
import { createNonce, renderChatHtml } from './chatHtml';
import { suggestMentions } from './mentionSuggest';
import type { ChatProjectStatus, FromWebviewMessage, ToWebviewMessage } from './protocol';
import { ChatSession } from './ChatSession';
import { HttpLlmClient } from '../../core/llm/client';
import { isAbortError } from '../../core/llm/errors';
import { getSettings, hasApiKey, hasWebSearchApiKey, getAdminPolicySnapshot, isAdminPolicyActive, onSettingsChanged, setSessionModel } from '../../core/config/settings';
import { getPersistedAlwaysAllow } from '../../core/stores/alwaysAllowStore';
import { loadWebviewL10n } from '../../l10n/loadBundle';
import { SettingsPanel } from './SettingsPanel';
import type { ConfirmDialogOptions } from '../../host/ui/confirmDialog';
import { isProjectEnabled } from '../project/config';
import { getIndexManager } from '../index/IndexManager';

export class ChatViewProvider implements vscode.WebviewViewProvider {
	// Все активные chat webview (panel + sidebar могут быть одновременно)
	private readonly views = new Set<vscode.WebviewView>();
	private readonly client = new HttpLlmClient();
	private readonly session: ChatSession;
	private modelsAbort?: AbortController;

	constructor(
		private readonly context: vscode.ExtensionContext,
		// Общая сессия для panel + sidebar (иначе создаём свою)
		sharedSession?: ChatSession,
	) {
		this.session = sharedSession ?? new ChatSession(context, this.client);
		this.session.setWebviewPoster((message) => this.post(message));
		this.session.subscribe(() => {
			void this.postState();
		});
		onSettingsChanged(() => {
			void this.postState();
			void (async () => {
				const snap = getAdminPolicySnapshot();
				this.post({
					type: 'settings',
					settings: getSettings(),
					apiKeySet: await hasApiKey(),
					webSearchApiKeySet: await hasWebSearchApiKey(),
					persistedAlwaysAllow: getPersistedAlwaysAllow(),
					adminPolicy: {
						active: isAdminPolicyActive(),
						path: snap.path,
						lockedKeys: [...snap.lockedKeys],
					},
				});
			})();
		});
		getIndexManager()?.onDidChange(() => {
			void this.postState();
		});
	}

	getSession(): ChatSession {
		return this.session;
	}

	requestConfirm(options: ConfirmDialogOptions) {
		return this.session.requestConfirm({
			title: options.title,
			detail: options.detail,
			hint: vscode.l10n.t('confirm.panelHint'),
			variant: options.variant,
			applyLabel: options.applyLabel,
			rejectLabel: options.rejectLabel,
		});
	}

	addSelectionToChat(): Promise<void> {
		return this.session.addSelectionToChat();
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.views.add(webviewView);

		const assetsRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
		const codiconsRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'codicons');
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [assetsRoot, codiconsRoot],
		};

		const l10n = loadWebviewL10n(this.context.extensionUri);
		webviewView.webview.html = renderChatHtml({
			cspSource: webviewView.webview.cspSource,
			nonce: createNonce(),
			scriptUri: webviewView.webview.asWebviewUri(vscode.Uri.joinPath(assetsRoot, 'index.js')),
			styleUri: webviewView.webview.asWebviewUri(vscode.Uri.joinPath(assetsRoot, 'index.css')),
			codiconsStyleUri: webviewView.webview.asWebviewUri(vscode.Uri.joinPath(codiconsRoot, 'codicon.css')),
			title: l10n.strings['chat.webviewTitle'],
			screen: 'chat',
			l10n,
		});

		const messageSub = webviewView.webview.onDidReceiveMessage((msg: FromWebviewMessage) => {
			void this.onWebviewMessage(msg);
		});

		webviewView.onDidDispose(() => {
			messageSub.dispose();
			this.views.delete(webviewView);
		});
	}

	private post(message: ToWebviewMessage): void {
		for (const view of this.views) {
			void view.webview.postMessage(message);
		}
	}

	private async buildProjectStatus(): Promise<ChatProjectStatus> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			return {
				hasWorkspace: false,
				enabled: false,
				indexing: false,
				ready: false,
			};
		}

		const enabled = await isProjectEnabled(folder.uri.fsPath);
		const progress = getIndexManager()?.getProgress(folder.uri.fsPath);
		return {
			hasWorkspace: true,
			enabled,
			indexing: progress?.state === 'indexing',
			ready: progress?.state === 'ready',
			error: progress?.lastError,
			fileCount: progress?.fileCount,
			chunkCount: progress?.chunkCount,
		};
	}

	private async postState(): Promise<void> {
		const project = await this.buildProjectStatus();
		this.post({
			type: 'state',
			state: {
				...this.session.getState(),
				project,
			},
		});
	}

	private async onWebviewMessage(msg: FromWebviewMessage): Promise<void> {
		switch (msg.type) {
			case 'ready':
				await this.postState();
				// Settings нужны webview для loadModels(baseUrl) на экране чата
				{
					const snap = getAdminPolicySnapshot();
					this.post({
						type: 'settings',
						settings: getSettings(),
						apiKeySet: await hasApiKey(),
						webSearchApiKeySet: await hasWebSearchApiKey(),
						persistedAlwaysAllow: getPersistedAlwaysAllow(),
						adminPolicy: {
							active: isAdminPolicyActive(),
							path: snap.path,
							lockedKeys: [...snap.lockedKeys],
						},
					});
				}
				return;
			case 'clear':
				this.session.clear();
				return;
			case 'cancel':
				this.session.cancel();
				return;
			case 'send':
				await this.session.send(msg.text, msg.images);
				return;
			case 'editMessage':
				await this.session.editMessage(msg.id, msg.content, {
					revertFiles: msg.revertFiles,
				});
				return;
			case 'reviewHunk':
				await this.session.reviewHunk(msg.toolCallId, msg.hunkId, msg.action);
				return;
			case 'reviewDiff':
				await this.session.reviewDiff(msg.toolCallId, msg.action);
				return;
			case 'reviewPendingPath':
				await this.session.reviewPendingPath(msg.path, msg.action);
				return;
			case 'mentionSuggest': {
				const items = await suggestMentions(msg.query);
				this.post({
					type: 'mentionSuggestions',
					requestId: msg.requestId,
					items,
				});
				return;
			}
			case 'setChatMode':
				await this.session.setMode(msg.mode);
				return;
			case 'setModel':
				this.session.setModel(msg.model);
				return;
			case 'loadModels':
				await this.handleLoadModels(msg.baseUrl, msg.requestId);
				return;
			case 'checkConnection':
				await this.handleCheckConnection(msg.baseUrl, msg.requestId);
				return;
			case 'openSettings':
				SettingsPanel.show(this.context);
				return;
			case 'confirmChoice':
				this.session.resolveConfirm(msg.id, msg.choice);
				return;
			case 'answerQuestion':
				this.session.answerQuestion(msg.id, msg.answer);
				return;
			case 'retryIndex': {
				const folder = vscode.workspace.workspaceFolders?.[0];
				if (folder) {
					await getIndexManager()?.enableAndIndex(folder);
				}
				await this.postState();
				return;
			}
			case 'openExternal': {
				try {
					const uri = vscode.Uri.parse(msg.url);
					if (uri.scheme === 'http' || uri.scheme === 'https') {
						await vscode.env.openExternal(uri);
					}
				} catch {}
				return;
			}
			case 'newSession':
				this.session.createSession();
				return;
			case 'switchSession':
				this.session.switchSession(msg.id);
				return;
			case 'renameSession':
				this.session.renameSession(msg.id, msg.title);
				return;
			case 'deleteSession': {
				const deleteLabel = vscode.l10n.t('chat.session.delete');
				const choice = await vscode.window.showWarningMessage(
					vscode.l10n.t('chat.session.deleteConfirm'),
					{ modal: true },
					deleteLabel,
				);
				if (choice === deleteLabel) {
					this.session.deleteSession(msg.id);
				}
				return;
			}
			case 'forkSession':
				this.session.forkFromMessage(msg.messageId);
				return;
			case 'setComposerDraft':
				this.session.setComposerDraft(msg.text, msg.chips, msg.sessionId);
				return;
			case 'continueAgent':
				await this.session.continueAgent();
				return;
			case 'stopAgentPause':
				this.session.stopAgentPause();
				return;
			case 'cancelToolCall':
				this.session.cancelToolCall(msg.id);
				return;
			case 'dismissPlanHandoff':
				this.session.dismissPlanHandoff();
				return;
			case 'dismissTurnDiff':
				this.session.dismissTurnDiff();
				return;
			case 'restoreExportArchive':
				await this.session.restoreExportArchive();
				return;
			case 'openPath': {
				const path = String(msg.path ?? '').trim();
				if (!path) {
					return;
				}
				await this.session.openEditedPath(path);
				return;
			}
			case 'interruptResearchJob': {
				const id = (msg.id ?? msg.jobId ?? '').trim();
				if (id) {
					this.session.interruptResearchJob(id);
				}
				return;
			}
			case 'interruptAllResearch':
				this.session.interruptAllResearch();
				return;
			case 'resumeResearchJob': {
				const id = (msg.id ?? msg.jobId ?? '').trim();
				if (id) {
					this.session.resumeResearchJob(id);
				}
				return;
			}
			case 'openChildSession':
				this.session.openChildSession(msg.sessionId);
				return;
			case 'attachResearchTranscript': {
				const id = (msg.id ?? msg.jobId ?? '').trim();
				if (id) {
					this.session.attachResearchTranscript(id);
				}
				return;
			}
			case 'cleanupWorktree':
			case 'removeWorktree':
				await this.session.cleanupWorktree(msg.path);
				return;
			case 'cleanupAllFinishedWorktrees':
				await this.session.cleanupAllFinishedWorktrees();
				return;
			case 'openProjectReport': {
				const path = String(msg.path ?? '').trim();
				if (!path) {
					return;
				}
				await this.session.openEditedPath(path);
				return;
			}
		}
	}

	// Загрузить список моделей для компактного picker в шапке чата
	private async handleCheckConnection(baseUrl: string, requestId: number): Promise<void> {
		this.modelsAbort?.abort();
		const controller = new AbortController();
		this.modelsAbort = controller;

		try {
			const health = await this.client.checkConnectionHealth({
				baseUrl,
				signal: controller.signal,
			});
			if (controller.signal.aborted) {
				return;
			}

			this.post({
				type: 'connectionHealth',
				ok: health.ok,
				modelCount: health.modelCount,
				message: health.message,
				requestId,
			});
		} catch (err) {
			if (isAbortError(err) || controller.signal.aborted) {
				return;
			}

			this.post({
				type: 'connectionHealth',
				ok: false,
				modelCount: 0,
				message: err instanceof Error ? err.message : String(err),
				requestId,
			});
		} finally {
			if (this.modelsAbort === controller) {
				this.modelsAbort = undefined;
			}
		}
	}

	private async handleLoadModels(baseUrl: string, requestId: number): Promise<void> {
		this.modelsAbort?.abort();
		const controller = new AbortController();
		this.modelsAbort = controller;

		try {
			const models = await this.client.listModelOptions({
				baseUrl,
				signal: controller.signal,
			});
			if (controller.signal.aborted) {
				return;
			}

			if (models.length > 0) {
				const current = getSettings().model;
				if (!current || !models.some((item) => item.id === current)) {
					setSessionModel(models[0].id);
				}
			}

			this.post({
				type: 'models',
				models,
				requestId,
			});
		} catch (err) {
			if (isAbortError(err) || controller.signal.aborted) {
				return;
			}

			this.post({
				type: 'modelsError',
				message: err instanceof Error ? err.message : String(err),
				requestId,
			});
		} finally {
			if (this.modelsAbort === controller) {
				this.modelsAbort = undefined;
			}
		}
	}
}
