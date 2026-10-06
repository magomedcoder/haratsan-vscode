import * as vscode from 'vscode';
import { AGENT_LIMITS } from '../../policy';
import { asOptionalInt, asString, type ToolContext, type ToolDefinition, type ToolResult } from '../../types';
import { relativeFromUri, resolveWorkspacePath, throwIfAborted } from '../../workspacePath';

type LspAction = 'definition' | 'references' | 'hover' | 'symbols';

const ACTIONS = new Set<LspAction>(['definition', 'references', 'hover', 'symbols']);

function parsePosition(args: Record<string, unknown>): vscode.Position | { error: string } {
	const line = asOptionalInt(args, 'line');
	const character = asOptionalInt(args, 'character');
	if (line === undefined || line < 0) {
		return { 
			error: 'lsp: нужен line (целое ≥ 0, 0-based)'
		};
	}

	if (character === undefined || character < 0) {
		return {
			error: 'lsp: нужен character (целое ≥ 0, 0-based)'
		};
	}

	return new vscode.Position(line, character);
}

function locationPayload(loc: vscode.Location | vscode.LocationLink): Record<string, unknown> {
	if (loc instanceof vscode.Location) {
		return {
			uri: loc.uri.toString(),
			range: {
				start: { 
					line: loc.range.start.line, 
					character: loc.range.start.character 
				},
				end: { 
					line: loc.range.end.line, 
					character: loc.range.end.character 
				},
			},
		};
	}

	const target = loc.targetSelectionRange ?? loc.targetRange;
	return {
		uri: loc.targetUri.toString(),
		range: {
			start: { 
				line: target.start.line, 
				character: target.start.character 
			},
			end: { 
				line: target.end.line, 
				character: target.end.character 
			},
		},
		originSelectionRange: loc.originSelectionRange
			? {
				start: { 
					line: loc.originSelectionRange.start.line, 
					character: loc.originSelectionRange.start.character 
				},
				end: { 
					line: loc.originSelectionRange.end.line, 
					character: loc.originSelectionRange.end.character 
				},
			}
			: null,
	};
}

function symbolPayload(sym: vscode.DocumentSymbol, path: string): Record<string, unknown> {
	return {
		name: sym.name,
		detail: sym.detail || undefined,
		kind: vscode.SymbolKind[sym.kind] ?? sym.kind,
		path,
		range: {
			start: { 
				line: sym.range.start.line, 
				character: sym.range.start.character 
			},
			end: { 
				line: sym.range.end.line, 
				character: sym.range.end.character 
			},
		},
		selectionRange: {
			start: { 
				line: sym.selectionRange.start.line, 
				character: sym.selectionRange.start.character 
			},
			end: { 
				line: sym.selectionRange.end.line, 
				character: sym.selectionRange.end.character 
			},
		},
		children: sym.children?.length
			? sym.children.map((c) => symbolPayload(c, path))
			: undefined,
	};
}

function flattenSymbolInfo(info: vscode.SymbolInformation, path: string): Record<string, unknown> {
	return {
		name: info.name,
		kind: vscode.SymbolKind[info.kind] ?? info.kind,
		containerName: info.containerName || undefined,
		path,
		range: {
			start: { 
				line: info.location.range.start.line, 
				character: info.location.range.start.character 
			},
			end: { 
				line: info.location.range.end.line, 
				character: info.location.range.end.character 
			},
		},
	};
}

async function enrichLocations(
	items: Array<vscode.Location | vscode.LocationLink>,
): Promise<Array<Record<string, unknown>>> {
	const out: Array<Record<string, unknown>> = [];
	for (const item of items.slice(0, AGENT_LIMITS.maxDiagnostics)) {
		const base = locationPayload(item);
		try {
			const uri = item instanceof vscode.Location ? item.uri : item.targetUri;
			base.path = await relativeFromUri(uri);
		} catch {
			base.path = null;
		}
		out.push(base);
	}

	return out;
}

export const lspTool: ToolDefinition = {
	name: 'lsp',
	description: 'Языковые сервисы VSCode: definition | references | hover | symbols. Координаты line и character - 0-based (как LSP). Только чтение.',
	parameters: {
		type: 'object',
		properties: {
			action: {
				type: 'string',
				description: 'definition | references | hover | symbols',
				enum: ['definition', 'references', 'hover', 'symbols'],
			},
			path: {
				type: 'string',
				description: 'Путь к файлу в workspace',
			},
			line: {
				type: 'integer',
				description: 'Строка, 0-based (первая строка = 0)',
			},
			character: {
				type: 'integer',
				description: 'Колонка, 0-based (первый символ = 0). Для symbols можно 0',
			},
		},
		required: ['action', 'path'],
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const actionRaw = asString(args, 'action').trim().toLowerCase();
		if (!ACTIONS.has(actionRaw as LspAction)) {
			return {
				ok: false,
				content: 'lsp: action должен быть definition | references | hover | symbols',
			};
		}

		const action = actionRaw as LspAction;
		const resolved = await resolveWorkspacePath(asString(args, 'path'));
		const doc = await vscode.workspace.openTextDocument(resolved.uri);

		if (action === 'symbols') {
			throwIfAborted(ctx.signal);
			const symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined>('vscode.executeDocumentSymbolProvider', doc.uri);
			const items = (symbols ?? []).slice(0, AGENT_LIMITS.maxDiagnostics).map((sym) => {
				if (sym instanceof vscode.DocumentSymbol) {
					return symbolPayload(sym, resolved.relative);
				}

				return flattenSymbolInfo(sym, resolved.relative);
			});

			return {
				ok: true,
				path: resolved.relative,
				content: JSON.stringify({
					action,
					path: resolved.relative,
					count: items.length,
					symbols: items,
				}, null, 2),
			};
		}

		const pos = parsePosition(args);
		if ('error' in pos) {
			return {
				ok: false,
				content: pos.error,
			};
		}

		throwIfAborted(ctx.signal);

		if (action === 'definition') {
			const defs = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>('vscode.executeDefinitionProvider', doc.uri, pos);
			const locations = await enrichLocations(defs ?? []);
			return {
				ok: true,
				path: resolved.relative,
				content: JSON.stringify({
					action,
					path: resolved.relative,
					position: { 
						line: pos.line, 
						character: pos.character 
					},
					count: locations.length,
					definitions: locations,
				}, null, 2),
			};
		}

		if (action === 'references') {
			const refs = await vscode.commands.executeCommand<vscode.Location[] | undefined>('vscode.executeReferenceProvider', doc.uri, pos);
			const locations = await enrichLocations(refs ?? []);
			return {
				ok: true,
				path: resolved.relative,
				content: JSON.stringify({
					action,
					path: resolved.relative,
					position: { 
						line: pos.line, 
						character: pos.character 
					},
					count: locations.length,
					references: locations,
				}, null, 2),
			};
		}

		// hover
		const hovers = await vscode.commands.executeCommand<vscode.Hover[] | undefined>(
			'vscode.executeHoverProvider',
			doc.uri,
			pos,
		);
		const contents = (hovers ?? []).flatMap((h) =>
			h.contents.map((c) => {
				if (typeof c === 'string') {
					return c;
				}

				if (c instanceof vscode.MarkdownString) {
					return c.value;
				}

				return (c as { value?: string }).value ?? String(c);
			}),
		);

		const clipped = contents.join('\n\n');
		const text = clipped.length > AGENT_LIMITS.maxSelectionChars
			? `${clipped.slice(0, AGENT_LIMITS.maxSelectionChars)}\n...`
			: clipped;

		return {
			ok: true,
			path: resolved.relative,
			content: JSON.stringify({
				action,
				path: resolved.relative,
				position: { 
					line: pos.line, 
					character: pos.character 
				},
				hover: text || null,
			}, null, 2),
		};
	},
};
