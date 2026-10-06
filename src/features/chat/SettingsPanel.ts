import * as path from 'node:path';
import * as vscode from 'vscode';
import { getEffectiveHooksPath } from '../../core/config/layers';
import { clearApiKey, clearWebSearchApiKey, getSettings, hasApiKey, hasWebSearchApiKey, isAdminPolicyActive, setApiKey, setSessionModel, setWebSearchApiKey, updateSettings, getAdminPolicySnapshot } from '../../core/config/settings';
import { getPersistedAlwaysAllow, setPersistedAlwaysAllow } from '../../core/stores/alwaysAllowStore';
import { collectIndexEngineStatus } from '../index/engineStatus';
import { getIndexManagerInstance } from '../index/IndexManager';
import { HttpLlmClient } from '../../core/llm/client';
import { loadWebviewL10n } from '../../l10n/loadBundle';
import { revealLogsFolder } from '../../core/log/logger';
import { discoverPersonas } from '../project/personas';
import { BUILTIN_PRESETS, cloneBuiltinPreset, discoverCustomAgents } from '../project/customAgents';
import { listRulesCandidates } from '../project/projectRules';
import { discoverSkills } from '../project/skills';
import { discoverLocalPlugins } from '../project/plugins';
import { clearActivity, readActivity } from '../../core/stores/activityStore';
import { readUsage, resetUsage } from '../../core/stores/usageStore';
import { createNonce, renderChatHtml } from './chatHtml';
import type { AdminPolicyInfo, FromWebviewMessage, PersonaOption, ToWebviewMessage } from './protocol';
const VIEW_TYPE = 'haratsan.settings';
function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === 'AbortError';
}

export class SettingsPanel {
	private static current?: SettingsPanel;
	private modelsAbort?: AbortController;
	private readonly client = new HttpLlmClient();
	private indexChangeSub?: vscode.Disposable;

	static show(context: vscode.ExtensionContext): void {
		if (SettingsPanel.current) {
			SettingsPanel.current.panel.reveal();
			return;
		}

		const assetsRoot = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
		const codiconsRoot = vscode.Uri.joinPath(context.extensionUri, 'media', 'codicons');
		const panel = vscode.window.createWebviewPanel(VIEW_TYPE, vscode.l10n.t('settings.panelTitle'), vscode.ViewColumn.Active, {
			enableScripts: true,
			enableFindWidget: true,
			retainContextWhenHidden: true,
			localResourceRoots: [assetsRoot, codiconsRoot],
		});
		panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'logo.svg');
		SettingsPanel.current = new SettingsPanel(panel, assetsRoot, context, codiconsRoot);
	}

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		assetsRoot: vscode.Uri,
		private readonly context: vscode.ExtensionContext,
		codiconsRoot: vscode.Uri,
	) {
		const l10n = loadWebviewL10n(this.context.extensionUri);
		this.panel.webview.html = renderChatHtml({
			cspSource: this.panel.webview.cspSource,
			nonce: createNonce(),
			scriptUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(assetsRoot, 'index.js')),
			styleUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(assetsRoot, 'index.css')),
			codiconsStyleUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(codiconsRoot, 'codicon.css')),
			title: l10n.strings['settings.webviewTitle'],
			screen: 'settings',
			l10n,
		});

		const messageSub = this.panel.webview.onDidReceiveMessage((msg: FromWebviewMessage) => {
			void this.onMessage(msg);
		});

		// Живой статус индексации, пока открыты Settings
		this.indexChangeSub = getIndexManagerInstance()?.onDidChange(() => {
			void this.postIndexStatus();
		});

		this.panel.onDidDispose(() => {
			messageSub.dispose();
			this.indexChangeSub?.dispose();
			this.indexChangeSub = undefined;
			this.modelsAbort?.abort();
			if (SettingsPanel.current === this) {
				SettingsPanel.current = undefined;
			}
		});
	}

	private post(message: ToWebviewMessage): void {
		void this.panel.webview.postMessage(message);
	}

	private async listPersonaOptions(): Promise<PersonaOption[]> {
		try {
			const list = await discoverPersonas();
			return list.map((p) => ({
				id: p.id,
				name: p.name,
				description: p.description,
				path: p.path || undefined,
				source: p.source,
			}));
		} catch {
			return [];
		}
	}

	// Отправить актуальный список персон в webview (Reload на странице Personas)
	private async postPersonasData(): Promise<void> {
		this.post({
			type: 'personasData',
			personas: await this.listPersonaOptions(),
		});
	}

	private adminPolicyInfo(): AdminPolicyInfo {
		const snap = getAdminPolicySnapshot();
		return {
			active: isAdminPolicyActive(),
			path: snap.path,
			lockedKeys: [...snap.lockedKeys],
		};
	}

	private async postSettings(): Promise<void> {
		this.post({
			type: 'settings',
			settings: getSettings(),
			apiKeySet: await hasApiKey(),
			webSearchApiKeySet: await hasWebSearchApiKey(),
			persistedAlwaysAllow: getPersistedAlwaysAllow(),
			personas: await this.listPersonaOptions(),
			adminPolicy: this.adminPolicyInfo(),
		});
		await this.postIndexStatus();
	}

	// Статус движка индекса (CPU/remote/...) для секции Indexing
	private async postIndexStatus(): Promise<void> {
		this.post({
			type: 'indexStatus',
			status: await collectIndexEngineStatus(),
		});
	}

	private async onMessage(msg: FromWebviewMessage): Promise<void> {
		switch (msg.type) {
			case 'ready':
				await this.postSettings();
				return;
			case 'openExternal': {
				try {
					const uri = vscode.Uri.parse(msg.url);
					if (uri.scheme === 'http' || uri.scheme === 'https') {
						await vscode.env.openExternal(uri);
					}
				} catch {}
				return;
			}
			case 'loadModels':
				await this.handleLoadModels(msg.baseUrl, msg.requestId);
				return;
			case 'checkConnection':
				await this.handleCheckConnection(msg.baseUrl, msg.requestId);
				return;
			case 'openLogsFolder':
				await revealLogsFolder();
				return;
			case 'loadUsage':
				this.post({
					type: 'usageLedger',
					ledger: readUsage(),
				});
				return;
			case 'resetUsage':
				resetUsage();
				this.post({
					type: 'usageLedger',
					ledger: readUsage(),
				});
				return;
			case 'loadActivity':
				this.post({
					type: 'activityLedger',
					entries: readActivity(),
				});
				return;
			case 'clearActivity':
				clearActivity();
				this.post({
					type: 'activityLedger',
					entries: readActivity(),
				});
				return;
			case 'loadIndexStatus':
				await this.postIndexStatus();
				return;
			case 'cancelIndex':
				getIndexManagerInstance()?.cancelIndex();
				await this.postIndexStatus();
				return;
			case 'repairIndex':
				await getIndexManagerInstance()?.repairAndReindex();
				await this.postIndexStatus();
				return;
			case 'loadHooks':
				await this.postHooksData();
				return;
			case 'saveHooks':
				await this.handleSaveHooks(
					msg.beforeSubmit,
					msg.beforeShell,
					msg.sessionDiff,
					msg.sessionCompacting,
					msg.shellEnv,
					msg.fileWatcher,
				);
				return;
			case 'openHooksFile':
				await this.handleOpenHooksFile();
				return;
			case 'loadAgents':
				await this.postAgentsData();
				return;
			case 'cloneAgentPreset':
				await this.handleCloneAgentPreset(msg.id);
				return;
			case 'loadRulesSkills':
				await this.postRulesSkillsData();
				return;
			case 'loadPersonas':
				await this.postPersonasData();
				return;
			case 'openProjectPath':
				await this.handleOpenProjectPath(msg.path);
				return;
			case 'saveSettings':
				try {
					if (msg.clearApiKey) {
						await clearApiKey();
					} else if (typeof msg.apiKey === 'string' && msg.apiKey.trim()) {
						await setApiKey(msg.apiKey);
					}

					if (msg.clearWebSearchApiKey) {
						await clearWebSearchApiKey();
					} else if (typeof msg.webSearchApiKey === 'string' && msg.webSearchApiKey.trim()) {
						await setWebSearchApiKey(msg.webSearchApiKey);
					}

					if (Array.isArray(msg.persistedAlwaysAllow)) {
						await setPersistedAlwaysAllow(msg.persistedAlwaysAllow);
					}

					const saved = await updateSettings({
						...msg.settings,
						webSearchApiKey: '',
					});
					this.post({
						type: 'settingsSaved',
						settings: saved,
						apiKeySet: await hasApiKey(),
						webSearchApiKeySet: await hasWebSearchApiKey(),
						persistedAlwaysAllow: getPersistedAlwaysAllow(),
						personas: await this.listPersonaOptions(),
						adminPolicy: this.adminPolicyInfo(),
					});
					// После сохранения - обновить статус индекса в фоне
					void this.postIndexStatus();
				} catch (err) {
					this.post({
						type: 'settingsError',
						message: err instanceof Error ? err.message : String(err),
					});
				}
				return;
		}
	}

	private hooksFileUri(): vscode.Uri | undefined {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			return undefined;
		}

		const configured = getEffectiveHooksPath();
		if (configured) {
			if (path.isAbsolute(configured)) {
				return vscode.Uri.file(configured);
			}
			
			return vscode.Uri.joinPath(folder.uri, configured);
		}

		return vscode.Uri.joinPath(folder.uri, '.haratsan', 'hooks.json');
	}

	// Разобрать список команд из hooks.json (строки или { command })
	private asHookCommands(raw: unknown): string[] {
		if (!Array.isArray(raw)) {
			return [];
		}

		const out: string[] = [];
		for (const item of raw) {
			if (typeof item === 'string' && item.trim()) {
				out.push(item.trim());
				continue;
			}

			if (item && typeof item === 'object' && typeof (item as { command?: unknown }).command === 'string') {
				const command = String((item as { command: string }).command).trim();
				if (command) {
					out.push(command);
				}
			}
		}

		return out;
	}

	// Первый непустой список из альтернативных ключей JSON
	private pickHookCommands(hooks: Record<string, unknown>, ...keys: string[]): string[] {
		for (const key of keys) {
			if (key in hooks) {
				return this.asHookCommands(hooks[key]);
			}
		}
		return [];
	}

	private async postHooksData(): Promise<void> {
		const uri = this.hooksFileUri();
		if (!uri) {
			this.post({
				type: 'hooksData',
				beforeSubmit: [],
				beforeShell: [],
				sessionDiff: [],
				sessionCompacting: [],
				shellEnv: [],
				fileWatcher: [],
				error: vscode.l10n.t('policy.noWorkspace'),
			});
			return;
		}

		const path = uri.fsPath;
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const raw = JSON.parse(new TextDecoder().decode(bytes)) as {
				hooks?: Record<string, unknown>;
				beforeSubmit?: unknown;
				beforeShell?: unknown;
			};
			const hooks = (raw.hooks ?? raw) as Record<string, unknown>;
			this.post({
				type: 'hooksData',
				beforeSubmit: this.asHookCommands(hooks.beforeSubmit),
				beforeShell: this.asHookCommands(hooks.beforeShell),
				sessionDiff: this.pickHookCommands(hooks, 'sessionDiff', 'session.diff'),
				sessionCompacting: this.pickHookCommands(
					hooks,
					'sessionCompacting',
					'session.compacting',
				),
				shellEnv: this.pickHookCommands(hooks, 'shellEnv', 'shell.env'),
				fileWatcher: this.pickHookCommands(hooks, 'fileWatcher', 'file.watcher'),
				path,
			});
		} catch (err) {
			const code = (err as { code?: string | number }).code;
			const name = (err as { name?: string }).name;
			// Файл отсутствует - пустые хуки, не ошибка
			if (code === 'FileNotFound' || code === 'ENOENT' || name === 'EntryNotFound') {
				this.post({
					type: 'hooksData',
					beforeSubmit: [],
					beforeShell: [],
					sessionDiff: [],
					sessionCompacting: [],
					shellEnv: [],
					fileWatcher: [],
					path,
				});
				return;
			}
			this.post({
				type: 'hooksData',
				beforeSubmit: [],
				beforeShell: [],
				sessionDiff: [],
				sessionCompacting: [],
				shellEnv: [],
				fileWatcher: [],
				path,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleSaveHooks(
		beforeSubmit: string[],
		beforeShell: string[],
		sessionDiff: string[],
		sessionCompacting: string[],
		shellEnv: string[],
		fileWatcher: string[],
	): Promise<void> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		const uri = this.hooksFileUri();
		if (!folder || !uri) {
			this.post({
				type: 'hooksSaved',
				ok: false,
				error: vscode.l10n.t('policy.noWorkspace'),
			});
			return;
		}

		try {
			const genDir = vscode.Uri.joinPath(folder.uri, '.haratsan');
			try {
				await vscode.workspace.fs.createDirectory(genDir);
			} catch {}

			const toCommands = (list: string[]) => list.map((c) => c.trim())
				.filter(Boolean)
				.map((command) => ({ command }));

			const payload = {
				beforeSubmit: toCommands(beforeSubmit),
				beforeShell: toCommands(beforeShell),
				sessionDiff: toCommands(sessionDiff),
				sessionCompacting: toCommands(sessionCompacting),
				'shell.env': toCommands(shellEnv),
				'file.watcher': toCommands(fileWatcher),
			};
			const text = `${JSON.stringify(payload, null, 2)}\n`;
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
			this.post({ type: 'hooksSaved', ok: true });
			await this.postHooksData();
		} catch (err) {
			this.post({
				type: 'hooksSaved',
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleOpenHooksFile(): Promise<void> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		const uri = this.hooksFileUri();
		if (!folder || !uri) {
			this.post({
				type: 'hooksData',
				beforeSubmit: [],
				beforeShell: [],
				sessionDiff: [],
				sessionCompacting: [],
				shellEnv: [],
				fileWatcher: [],
				error: vscode.l10n.t('policy.noWorkspace'),
			});
			return;
		}

		try {
			const genDir = vscode.Uri.joinPath(folder.uri, '.haratsan');
			try {
				await vscode.workspace.fs.createDirectory(genDir);
			} catch {}

			try {
				await vscode.workspace.fs.stat(uri);
			} catch {
				const empty = `${JSON.stringify({
					beforeSubmit: [],
					beforeShell: [],
					sessionDiff: [],
					sessionCompacting: [],
					'shell.env': [],
					'file.watcher': [],
				}, null, 2)}\n`;
				await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(empty));
			}

			const doc = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(doc, { preview: false });
		} catch (err) {
			this.post({
				type: 'hooksData',
				beforeSubmit: [],
				beforeShell: [],
				sessionDiff: [],
				sessionCompacting: [],
				shellEnv: [],
				fileWatcher: [],
				path: uri.fsPath,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Кандидаты rules + discovered skills/plugins для read-only UI
	private async postRulesSkillsData(): Promise<void> {
		try {
			const [rules, skillsRaw, pluginsRaw] = await Promise.all([
				listRulesCandidates(),
				discoverSkills(),
				discoverLocalPlugins(),
			]);
			this.post({
				type: 'rulesSkillsData',
				rules,
				skills: skillsRaw.map((s) => ({
					name: s.name,
					description: s.description,
					path: s.path,
				})),
				plugins: pluginsRaw.map((p) => ({
					kind: p.kind,
					name: p.name,
					description: p.description,
					path: p.path,
				})),
			});
		} catch {
			this.post({
				type: 'rulesSkillsData',
				rules: [],
				skills: [],
				plugins: [],
			});
		}
	}

	// Открыть файл в редакторе (workspace-relative или абсолютный) / http(s) во внешнем браузере
	private async handleOpenProjectPath(rawPath: string): Promise<void> {
		const input = String(rawPath ?? '').trim();
		if (!input) {
			return;
		}

		if (/^https?:\/\//i.test(input)) {
			try {
				await vscode.env.openExternal(vscode.Uri.parse(input));
			} catch {}
			return;
		}

		try {
			const isAbsolute = input.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(input);
			let uri: vscode.Uri;
			if (isAbsolute) {
				uri = vscode.Uri.file(input);
			} else {
				const folder = vscode.workspace.workspaceFolders?.[0];
				if (!folder) {
					return;
				}
				uri = vscode.Uri.joinPath(folder.uri, ...input.split(/[/\\]+/).filter(Boolean));
			}

			const doc = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(doc, { preview: true });
		} catch {}
	}

	// Отправить список builtin presets и кастомных агентов из `.haratsan/agents/`
	private async postAgentsData(): Promise<void> {
		try {
			const custom = await discoverCustomAgents();
			this.post({
				type: 'agentsData',
				presets: BUILTIN_PRESETS.map((p) => ({
					id: p.id,
					name: p.name,
					description: p.description,
					readonly: p.readonly,
					mode: p.mode,
				})),
				custom: custom.map((a) => ({
					id: a.id,
					name: a.name,
					description: a.description,
					readonly: a.readonly,
				})),
			});
		} catch (err) {
			this.post({
				type: 'agentsData',
				presets: BUILTIN_PRESETS.map((p) => ({
					id: p.id,
					name: p.name,
					description: p.description,
					readonly: p.readonly,
					mode: p.mode,
				})),
				custom: [],
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Клонировать builtin preset в `.haratsan/agents/` и открыть файл
	private async handleCloneAgentPreset(id: string): Promise<void> {
		try {
			const { relativePath, created } = await cloneBuiltinPreset(id);
			this.post({
				type: 'agentsCloned',
				relativePath,
				created,
			});
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (folder) {
				const uri = vscode.Uri.joinPath(folder.uri, relativePath);
				const doc = await vscode.workspace.openTextDocument(uri);
				await vscode.window.showTextDocument(doc, { preview: false });
			}
			await this.postAgentsData();
		} catch (err) {
			this.post({
				type: 'agentsCloned',
				relativePath: '',
				created: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

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
