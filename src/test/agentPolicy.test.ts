import * as assert from 'assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { applySearchReplace, PatchError } from '../features/agent/patch.js';
import { assertAllowedPath, isDeniedRelativePath, isOutsideWorkspaceInput, pathIsInside, resolveAgainstFolders, rewriteWorkspaceAlias } from '../features/agent/policy.js';
import { parseWorkspaceEdits } from '../features/agent/tools/fs/applyWorkspaceEdit.js';
import { assertAllowedCommand, CommandPolicyError, formatCommandLine } from '../features/agent/commandPolicy.js';
import { formatMiniDiff, computeMiniDiff, pathFromToolArguments, revertHunkInText } from '../features/agent/diff.js';
import { formatPlan, formatStickyPlanForPrompt, mutationPathsFromArgs, parsePlanArgs, StickyPlan } from '../features/agent/plan.js';
import { applyPlanFileText, parsePlanMarkdown, serializePlanMarkdown } from '../features/agent/planFile.js';
import { redactSecrets } from '../features/agent/secrets.js';
import { parseToolArguments, sanitizeToolArgumentsForApi } from '../features/agent/types.js';
import { AgentWriteTracker, denyWriteOverUserEdits } from '../features/agent/userEdits.js';
import { matchesSensitivePath } from '../features/agent/permissionPolicy.js';
import { DEFAULT_HARATSANIGNORE_PATTERNS, EXAMPLE_SECRET_PATTERNS, DEFAULT_SENSITIVE_PATH_PATTERNS } from '../core/config/types.js';

suite('path sandbox', () => {
	const root = path.resolve('/tmp/ws');

	test('относительный путь остаётся в workspace', () => {
		const { fsPath, folder, outside } = resolveAgainstFolders('src/a.ts', [root]);
		assert.strictEqual(folder, root);
		assert.strictEqual(outside, false);
		assert.ok(pathIsInside(fsPath, root));
		assert.strictEqual(assertAllowedPath(fsPath, folder), 'src/a.ts');
	});

	test('/workspace/foo резолвится внутрь первой папки', () => {
		assert.strictEqual(rewriteWorkspaceAlias('/workspace'), '.');
		assert.strictEqual(rewriteWorkspaceAlias('/workspace/foo'), 'foo');
		assert.strictEqual(rewriteWorkspaceAlias('\\workspace\\foo\\bar'), 'foo/bar');
		const { fsPath, folder, outside } = resolveAgainstFolders('/workspace/foo', [root]);
		assert.strictEqual(folder, root);
		assert.strictEqual(outside, false);
		assert.strictEqual(fsPath, path.resolve(root, 'foo'));
		assert.ok(pathIsInside(fsPath, root));
	});

	test('выход через .. запрещён', () => {
		assert.throws(() => resolveAgainstFolders('../secret', [root]));
	});

	test('allowOutside разрешает путь вне workspace', () => {
		const resolved = resolveAgainstFolders('../secret', [root], { allowOutside: true });
		assert.strictEqual(resolved.outside, true);
		assert.ok(!pathIsInside(resolved.fsPath, root));
	});

	test('пустой список ничего не запрещает', () => {
		assert.ok(!isDeniedRelativePath('node_modules/pkg/index.js', []));
		assert.ok(!isDeniedRelativePath('.env', []));
		assert.ok(!isDeniedRelativePath('certs/server.pem', []));
	});

	test('шаблоны из настроек запрещают .env, ключи и node_modules', () => {
		assert.ok(isDeniedRelativePath('node_modules/pkg/index.js', DEFAULT_HARATSANIGNORE_PATTERNS));
		assert.ok(isDeniedRelativePath('.env', DEFAULT_HARATSANIGNORE_PATTERNS));
		assert.ok(isDeniedRelativePath('app/.env.local', DEFAULT_HARATSANIGNORE_PATTERNS));
		assert.ok(isDeniedRelativePath('certs/server.pem', DEFAULT_HARATSANIGNORE_PATTERNS));
		assert.ok(isDeniedRelativePath('.git/config', DEFAULT_HARATSANIGNORE_PATTERNS));
		assert.ok(!isDeniedRelativePath('src/index.ts', DEFAULT_HARATSANIGNORE_PATTERNS));
	});

	test('sensitivePathPatterns ловит .env*', () => {
		assert.ok(matchesSensitivePath('.env', DEFAULT_SENSITIVE_PATH_PATTERNS));
		assert.ok(matchesSensitivePath('app/.env.local', DEFAULT_SENSITIVE_PATH_PATTERNS));
		assert.ok(!matchesSensitivePath('src/index.ts', DEFAULT_SENSITIVE_PATH_PATTERNS));
	});

	test('isOutsideWorkspaceInput', () => {
		assert.ok(!isOutsideWorkspaceInput('src/a.ts', [root]));
		assert.ok(isOutsideWorkspaceInput('../secret', [root]));
	});
});

suite('applySearchReplace', () => {
	test('одна замена', () => {
		const result = applySearchReplace('привет мир', 'мир', 'че там', false);
		assert.strictEqual(result.text, 'привет че там');
		assert.strictEqual(result.count, 1);
	});

	test('несколько вхождений без replace_all - ошибка', () => {
		assert.throws(
			() => applySearchReplace('a x a', 'a', 'b', false),
			(err: unknown) => err instanceof PatchError,
		);
	});

	test('replace_all заменяет все', () => {
		const result = applySearchReplace('a x a', 'a', 'b', true);
		assert.strictEqual(result.text, 'b x b');
		assert.strictEqual(result.count, 2);
	});

	test('фрагмент не найден', () => {
		assert.throws(() => applySearchReplace('abc', 'zzz', 'q', false));
	});
});

suite('parseWorkspaceEdits', () => {
	test('разбирает массив правок', () => {
		const edits = parseWorkspaceEdits({
			edits: [
				{
					path: 'a.ts',
					old_string: 'foo',
					new_string: 'bar'
				},
				{
					path: 'b.ts',
					old_string: 'x',
					new_string: 'y',
					replace_all: true
				},
			],
		});
		assert.strictEqual(edits.length, 2);
		assert.strictEqual(edits[0].path, 'a.ts');
		assert.strictEqual(edits[1].replace_all, true);
	});

	test('пустой или не массив - []', () => {
		assert.deepStrictEqual(parseWorkspaceEdits({}), []);
		assert.deepStrictEqual(parseWorkspaceEdits({ edits: 'nope' }), []);
	});
});

suite('formatMiniDiff', () => {
	test('одинаковый текст - пусто', () => {
		assert.strictEqual(formatMiniDiff('a\nb', 'a\nb'), '');
	});

	test('показывает контекст и +/- строки', () => {
		const diff = formatMiniDiff('keep\nold\nkeep2', 'keep\nnew\nkeep2');
		assert.ok(diff.includes(' keep'));
		assert.ok(diff.includes('-old'));
		assert.ok(diff.includes('+new'));
	});

	test('обрезает длинный diff', () => {
		const before = Array.from({ length: 120 }, (_, i) => `L${i}`).join('\n');
		const after = Array.from({ length: 120 }, (_, i) => `R${i}`).join('\n');
		const diff = formatMiniDiff(before, after);
		assert.ok(diff.includes('lines hidden') || diff.includes('строк скрыто') || diff.includes('diff.linesHidden'));
		assert.ok(diff.split('\n').length <= 82);
	});

	test('несколько удалённых хунков', () => {
		const before = 'a\nold1\nb\nold2\nc';
		const after = 'a\nnew1\nb\nnew2\nc';
		const mini = computeMiniDiff(before, after);
		assert.ok(mini.hunks.length >= 2);
		assert.strictEqual(revertHunkInText(after, mini.hunks[1]), 'a\nnew1\nb\nold2\nc');
		assert.strictEqual(revertHunkInText(after, mini.hunks[0]), 'a\nold1\nb\nnew2\nc');
	});
});

suite('revertHunkInText', () => {
	test('откатывает замену', () => {
		const before = 'keep\nold\nkeep2';
		const after = 'keep\nnew\nkeep2';
		const [hunk] = computeMiniDiff(before, after).hunks;
		assert.strictEqual(revertHunkInText(after, hunk), before);
	});

	test('откатывает добавление файла', () => {
		const after = 'line1\nline2';
		const [hunk] = computeMiniDiff('', after).hunks;
		assert.strictEqual(revertHunkInText(after, hunk), '');
	});
});

suite('pathFromToolArguments', () => {
	test('берёт path', () => {
		assert.strictEqual(pathFromToolArguments('{"path":"src/a.ts"}'), 'src/a.ts');
	});

	test('собирает path из steps плана', () => {
		assert.strictEqual(pathFromToolArguments('{"title":"x","steps":[{"path":"a.go"},{"path":"b.go"}]}'), 'a.go, b.go');
	});

	test('собирает path из edits', () => {
		assert.strictEqual(pathFromToolArguments('{"edits":[{"path":"a.ts"},{"path":"b.ts"},{"path":"a.ts"}]}'), 'a.ts, b.ts');
	});

	test('битый JSON без path - undefined', () => {
		assert.strictEqual(pathFromToolArguments('{'), undefined);
		assert.strictEqual(pathFromToolArguments('{}'), undefined);
	});

	test('достаёт path из обрезанного write_file JSON', () => {
		const raw = '{"path": "news/handlers/news_handler.go", "content": "package handlers\\n\\nfunc (h *NewsHandler) GetAllNews';
		assert.strictEqual(pathFromToolArguments(raw), 'news/handlers/news_handler.go');
	});
});

suite('tool argument JSON', () => {
	test('sanitize делает валидный JSON из обрезанной строки', () => {
		const raw = '{"path":"a.go","content":"package x';
		const sanitized = sanitizeToolArgumentsForApi(raw);
		const parsed = JSON.parse(sanitized) as { error: string; path: string };
		assert.strictEqual(parsed.error, 'invalid_or_truncated_json');
		assert.strictEqual(parsed.path, 'a.go');
	});

	test('parse объясняет обрезку и не пишет файл', () => {
		assert.throws(
			() => parseToolArguments('{"path":"a.go","content":"package x'),
			(err: unknown) => {
				if (!(err instanceof Error)) {
					return false;
				}

				const msg = err.message;
				return ((msg.includes('invalid JSON') || msg.includes('tool.invalidJsonArgs')) && (msg.includes('a.go') || msg.includes('tool.invalidJsonPath')) && (msg.includes('was not written') || msg.includes('tool.fileNotWritten')));
			},
		);
	});
});

suite('commandPolicy', () => {
	test('разрешает npm test, go test, python, go run', () => {
		assert.doesNotThrow(() => assertAllowedCommand('npm', ['test']));
		assert.doesNotThrow(() => assertAllowedCommand('go', ['test', './...']));
		assert.doesNotThrow(() => assertAllowedCommand('python', ['app.py']));
		assert.doesNotThrow(() => assertAllowedCommand('go', ['run', '.']));
	});

	test('запрещает npm install', () => {
		assert.throws(
			() => assertAllowedCommand('npm', ['install']),
			(err: unknown) => err instanceof CommandPolicyError,
		);
	});

	test('запрещает node -e, python -c, curl, rm, git push', () => {
		assert.throws(() => assertAllowedCommand('node', ['-e', '1']), (err: unknown) => err instanceof CommandPolicyError);
		assert.throws(() => assertAllowedCommand('python', ['-c', '1']), (err: unknown) => err instanceof CommandPolicyError);
		assert.throws(() => assertAllowedCommand('curl', ['https://example.com']), (err: unknown) => err instanceof CommandPolicyError);
		assert.throws(() => assertAllowedCommand('rm', ['-rf', 'src']), (err: unknown) => err instanceof CommandPolicyError);
		assert.throws(() => assertAllowedCommand('git', ['-C', '/tmp', 'push']), (err: unknown) => err instanceof CommandPolicyError);
	});

	test('пустой deniedCommands не блокирует curl по имени', () => {
		assert.doesNotThrow(() => assertAllowedCommand('curl', ['https://example.com'], []));
		assert.throws(
			() => assertAllowedCommand('curl', ['https://example.com'], ['curl']),
			(err: unknown) => err instanceof CommandPolicyError,
		);
	});

	test('pwsh/bash: -File / script.sh разрешены даже из denylist; -Command/-c запрещены', () => {
		assert.doesNotThrow(() => assertAllowedCommand('pwsh', ['-NoProfile', '-File', 'run.ps1'], ['pwsh']));
		assert.throws(
			() => assertAllowedCommand('pwsh', ['-Command', 'Write-Host 1'], ['pwsh']),
			(err: unknown) => err instanceof CommandPolicyError,
		);
		assert.doesNotThrow(() => assertAllowedCommand('bash', ['script.sh'], ['bash']));
		assert.throws(
			() => assertAllowedCommand('bash', ['-c', 'echo 1'], ['bash']),
			(err: unknown) => err instanceof CommandPolicyError,
		);
	});

	test('gcc -c файл можно, python -c код нельзя', () => {
		assert.doesNotThrow(() => assertAllowedCommand('gcc', ['-c', 'foo.c']));
		assert.doesNotThrow(() => assertAllowedCommand('tar', ['-c', '-f', 'out.tar', 'src']));
		assert.doesNotThrow(() => assertAllowedCommand('git', ['-c', 'user.name=gen', 'status']));
		assert.throws(() => assertAllowedCommand('python', ['-c', 'print(1)']), (err: unknown) => err instanceof CommandPolicyError);
		assert.throws(() => assertAllowedCommand('ruby', ['-c', 'p 1']), (err: unknown) => err instanceof CommandPolicyError);
	});

	test('formatCommandLine экранирует пробелы', () => {
		assert.strictEqual(formatCommandLine('npm', ['run', 'my script']), 'npm run "my script"');
	});
});

suite('StickyPlan', () => {
	test('один файл без плана разрешён', () => {
		const plan = new StickyPlan();
		assert.strictEqual(plan.guard(['src/a.ts']), undefined);
		assert.strictEqual(plan.guard(['src/a.ts']), undefined);
	});

	test('второй файл без плана запрещён', () => {
		const plan = new StickyPlan();
		assert.ok(!plan.guard(['a.ts']));
		const denied = plan.guard(['b.ts']);
		assert.ok(denied?.denied);
		assert.ok(denied?.content.includes('propose_plan'));
	});

	test('apply_workspace_edit на два файла требует план', () => {
		const plan = new StickyPlan();
		const paths = mutationPathsFromArgs('apply_workspace_edit', {
			edits: [{ path: 'a.ts' }, { path: 'b.ts' }],
		});
		assert.deepStrictEqual(paths, ['a.ts', 'b.ts']);
		assert.ok(plan.guard(paths)?.denied);
	});

	test('после approve пути из плана можно на следующих «ходах»', () => {
		const plan = new StickyPlan();
		plan.approve({
			title: 'Фича',
			steps: [
				{ 
					title: 'a', 
					path: 'a.ts' 
				},
				{ 
					title: 'b', 
					path: 'b.ts' 
				},
			],
		});
		assert.ok(!plan.guard(['a.ts', 'b.ts']));
		assert.ok(plan.guard(['c.ts'])?.denied);
	});

	test('markDoneByPaths и prompt appendix', () => {
		const plan = new StickyPlan();
		plan.approve({
			title: 'Фича',
			steps: [
				{ 
					title: 'a', 
					path: 'a.ts' 
				},
				{ 
					title: 'b', 
					path: 'b.ts' 
				},
			],
		});
		plan.markDoneByPaths(['a.ts']);
		const snap = plan.snapshot()!;
		assert.strictEqual(snap.steps[0].status, 'done');
		assert.strictEqual(snap.steps[1].status, 'pending');
		const text = formatStickyPlanForPrompt(snap);
		assert.ok(text.includes('Активный план'));
		assert.ok(text.includes('[done]'));
	});
});

suite('plan markdown file', () => {
	test('serialize/parse roundtrip', () => {
		const snap = {
			title: 'Фича',
			approved: true,
			steps: [
				{ 
					title: 'handler', 
					path: 'a.go', 
					action: 'write', 
					status: 'pending' as const 
				},
				{ 
					title: 'тесты', 
					path: 'a_test.go', 
					status: 'done' as const 
				},
				{ 
					title: 'пропуск', 
					status: 'skipped' as const 
				},
				{ 
					title: 'в работе', 
					path: 'b.go', 
					status: 'in_progress' as const 
				},
			],
		};
		const md = serializePlanMarkdown(snap);
		assert.ok(md.includes('# Фича'));
		assert.ok(md.includes('[x]'));
		const parsed = parsePlanMarkdown(md);
		assert.strictEqual(parsed.title, 'Фича');
		assert.strictEqual(parsed.steps.length, 4);
		assert.strictEqual(parsed.steps[0].path, 'a.go');
		assert.strictEqual(parsed.steps[1].status, 'done');
		assert.strictEqual(parsed.steps[2].status, 'skipped');
		assert.strictEqual(parsed.steps[3].status, 'in_progress');
	});

	test('applyPlanFileText отдаёт userDiff при ручной правке', () => {
		const plan = new StickyPlan();
		const first = serializePlanMarkdown({
			title: 'A',
			approved: true,
			steps: [{ 
				title: 'one', 
				path: 'a.ts', 
				status: 'pending' 
			}],
		});
		applyPlanFileText(plan, first, '');
		const edited = first.replace('one', 'one edited');
		const result = applyPlanFileText(plan, edited, first);
		assert.ok(!result.empty);
		assert.ok(result.userDiff);
		assert.ok(plan.snapshot()?.steps[0].title.includes('edited'));
	});

	test('пустой файл / без шагов', () => {
		const plan = new StickyPlan();
		plan.approve({ 
			title: 'x', 
			steps: [{ 
				title: 'a', 
				path: 'a.ts' 
			}] 
		});
		const empty = applyPlanFileText(plan, '', 'old');
		assert.ok(empty.empty);
		assert.ok(!plan.hasPlan);
		assert.throws(() => parsePlanMarkdown('# Only title\n\n'));
	});
});

suite('parsePlanArgs', () => {
	test('форматирует шаги', () => {
		const parsed = parsePlanArgs({
			title: 'Фича',
			steps: [
				{ title: 'handler', path: 'news/handlers/news_handler.go', action: 'write' },
				{ summary: 'тесты', path: 'news/handlers/news_handler_test.go' },
			],
		});
		assert.strictEqual(parsed.steps.length, 2);
		const text = formatPlan(parsed);
		assert.ok(text.includes('Фича'));
		assert.ok(text.includes('news/handlers/news_handler.go'));
	});

	test('пустые steps - ошибка', () => {
		assert.throws(() => parsePlanArgs({ title: 'x', steps: [] }));
	});
});

suite('redactSecrets', () => {
	test('без шаблонов ничего не маскирует', () => {
		const raw = 'token: supersecretvalue extra';
		const { text, count } = redactSecrets(raw, []);
		assert.strictEqual(count, 0);
		assert.strictEqual(text, raw);
	});

	test('маскирует ключи по шаблонам из настроек', () => {
		const raw = 'token: supersecretvalue extra eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signaturexx';
		const { text, count } = redactSecrets(raw, EXAMPLE_SECRET_PATTERNS);
		assert.ok(count >= 1);
		assert.ok(!text.includes('supersecretvalue'));
		assert.ok(text.includes('[REDACTED]'));
	});
});

suite('AgentWriteTracker', () => {
	test('ловит drift после снимка агента', () => {
		const tracker = new AgentWriteTracker();
		const uri = vscode.Uri.file('/tmp/gen-p11-user-edits.ts');
		tracker.remember(uri, 'gen-p11-user-edits.ts', 'const a = 1;\n');
		assert.ok(!tracker.hasUserEdits(uri, 'const a = 1;\n'));
		assert.ok(tracker.hasUserEdits(uri, 'const a = 2;\n'));
		const diff = tracker.userDiff(uri, 'const a = 2;\n');
		assert.ok(diff && diff.includes('-') && diff.includes('+'));
	});

	test('denyWriteOverUserEdits указывает на точечные правки', () => {
		const msg = denyWriteOverUserEdits('src/a.ts', '-old\n+new');
		assert.ok(msg.includes('write_file'));
		assert.ok(msg.includes('apply_patch') || msg.includes('apply_workspace_edit'));
		assert.ok(msg.includes('src/a.ts'));
	});
});
