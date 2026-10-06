import * as vscode from 'vscode';
import { registerChat } from '../features/chat';
import { initSettings } from '../core/config/settings';
import { initIndexManager } from '../features/index/IndexManager';
import { initLogger } from '../core/log/logger';
import { initFileWatcherHooks } from '../features/project/fileWatcherHooks';
import { initHaratsanRulesManager } from '../features/project/haratsanRules';
import { initActivityStore } from '../core/stores/activityStore';
import { initUsageStore } from '../core/stores/usageStore';
import { registerHostCommands } from './commands';
import { registerHostProviders } from './providers';

export function activate(context: vscode.ExtensionContext): void {
	initSettings(context);
	initLogger(context);
	initIndexManager(context);
	initHaratsanRulesManager(context);
	initFileWatcherHooks(context);
	initUsageStore(context);
	initActivityStore(context);

	const { diffProvider, disposables: providerDisposables } = registerHostProviders();

	context.subscriptions.push(
		...providerDisposables,
		...registerHostCommands(diffProvider),
		registerChat(context),
	);
}

export function deactivate(): void {}
