import { join } from 'node:path';
import * as vscode from 'vscode';
import { getSettings } from '../config/settings';
import { LogFileWriter, nodeLogFs } from './fileWriter';

export type LogStream = 'llm' | 'agent';

let writer: LogFileWriter | undefined;
let logsDir: string | undefined;
const channels: Partial<Record<LogStream, vscode.OutputChannel>> = {};
let ready = false;

export function initLogger(context: vscode.ExtensionContext): void {
	if (ready) {
		return;
	}

	ready = true;
	logsDir = join(context.globalStorageUri.fsPath, 'logs');
	writer = new LogFileWriter(nodeLogFs);
	channels.llm = vscode.window.createOutputChannel('Haratsan LLM');
	channels.agent = vscode.window.createOutputChannel('Haratsan Agent');
	context.subscriptions.push(channels.llm, channels.agent);
}

export function writeLog(stream: LogStream, line: string): void {
	if (!getSettings().loggingEnabled) {
		return;
	}

	channels[stream]?.appendLine(line);
	if (!writer || !logsDir) {
		return;
	}

	writer.enqueue(join(logsDir, `${stream}.log`), line);
}

/**
 * Всегда пишет в Output-канал (для opt-in OTEL без loggingEnabled).
 * На диск - только если loggingEnabled.
 */
export function appendLogLine(stream: LogStream, line: string): void {
	channels[stream]?.appendLine(line);
	if (!getSettings().loggingEnabled || !writer || !logsDir) {
		return;
	}

	writer.enqueue(join(logsDir, `${stream}.log`), line);
}

export async function revealLogsFolder(): Promise<void> {
	if (!logsDir) {
		return;
	}

	const uri = vscode.Uri.file(logsDir);
	try {
		await vscode.workspace.fs.createDirectory(uri);
	} catch {}

	await vscode.commands.executeCommand('revealFileInOS', uri);
}
