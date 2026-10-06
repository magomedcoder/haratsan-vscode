import * as assert from 'assert';
import { activeSlashQuery, filterSlashCommands, parseSlashMode } from '../features/chat/slashCommands.js';
import { expandCommandTemplate, analyzeCommandPlaceholders, validateCommandArgs, customToSlashCommand } from '../features/project/customCommands.js';
import { parseBangCommands, splitCommandLine } from '../features/chat/bangCommand.js';
import { splitIntoTurns } from '../features/chat/compact.js';

suite('slashCommands', () => {
	test('parseSlashMode: режимы', () => {
		assert.deepStrictEqual(parseSlashMode('/debug'), {
			mode: 'debug',
			command: 'debug',
			rest: '',
			custom: false,
		});
		assert.deepStrictEqual(parseSlashMode('/plan'), {
			mode: 'plan',
			command: 'plan',
			rest: '',
			custom: false,
		});
		assert.deepStrictEqual(parseSlashMode('/export'), {
			mode: undefined,
			command: 'export',
			rest: '',
			custom: false,
		});
		assert.deepStrictEqual(parseSlashMode('/import'), {
			mode: undefined,
			command: 'import',
			rest: '',
			custom: false,
		});
		assert.deepStrictEqual(parseSlashMode('/compact'), {
			mode: undefined,
			command: 'compact',
			rest: '',
			custom: false,
		});
		assert.deepStrictEqual(parseSlashMode('/restore-archive'), {
			mode: undefined,
			command: 'restore-archive',
			rest: '',
			custom: false,
		});
		assert.deepStrictEqual(parseSlashMode('/new'), {
			mode: undefined,
			command: 'new',
			rest: '',
			custom: false,
		});
		assert.deepStrictEqual(parseSlashMode('/redo'), {
			mode: undefined,
			command: 'redo',
			rest: '',
			custom: false,
		});
	});

	test('parseSlashMode: остаток после команды', () => {
		assert.deepStrictEqual(parseSlashMode('/debug почему падает?'), {
			mode: 'debug',
			command: 'debug',
			rest: 'почему падает?',
			custom: false,
		});
	});

	test('parseSlashMode: кастомные', () => {
		const extra = [{ id: 'custom:review', name: 'review', detail: 'Code review' }];
		assert.deepStrictEqual(parseSlashMode('/review foo', extra), {
			mode: undefined,
			command: 'review',
			rest: 'foo',
			custom: true,
		});
	});

	test('parseSlashMode: не команда', () => {
		assert.strictEqual(parseSlashMode('debug'), undefined);
		assert.strictEqual(parseSlashMode('/foobar'), undefined);
	});

	test('activeSlashQuery только в начале', () => {
		assert.deepStrictEqual(activeSlashQuery('/de', 3), {
			start: 0,
			query: 'de',
		});
		assert.strictEqual(activeSlashQuery('/debug x', 8), undefined);
	});

	test('filterSlashCommands', () => {
		assert.ok(filterSlashCommands('').length >= 10);
		assert.deepStrictEqual(
			filterSlashCommands('de').map((c) => c.name),
			['debug', 'design', 'deep-planning'],
		);
		assert.ok(filterSlashCommands('restore').some((c) => c.name === 'restore-archive'));
		assert.ok(filterSlashCommands('rev', [{ id: 'c', name: 'review', detail: 'x' }]).some((c) => c.name === 'review'));
	});

	test('expandCommandTemplate', () => {
		assert.strictEqual(
			expandCommandTemplate('Review $ARGUMENTS\nFile: $1', 'src/a.ts --strict'),
			'Review src/a.ts --strict\nFile: src/a.ts',
		);
	});

	test('validateCommandArgs / analyze placeholders', () => {
		const meta = analyzeCommandPlaceholders('Do $ARGUMENTS with $1 and $2');
		assert.strictEqual(meta.usesArguments, true);
		assert.strictEqual(meta.maxPositional, 2);
		assert.strictEqual(meta.required, true);
		assert.strictEqual(validateCommandArgs('Do $ARGUMENTS', '').ok, false);
		assert.strictEqual(validateCommandArgs('Do $ARGUMENTS', 'x').ok, true);
		assert.strictEqual(validateCommandArgs('A $1 $2', 'only-one').ok, false);
		assert.strictEqual(validateCommandArgs('A $1 $2', 'one two').ok, true);
		assert.strictEqual(validateCommandArgs('no placeholders', '').ok, true);
		const slash = customToSlashCommand({
			name: 'review',
			body: 'Review $ARGUMENTS',
			path: '.haratsan/commands/review.md',
			argumentsHint: 'path flags',
		});
		assert.strictEqual(slash.needsArgs, true);
		assert.ok(slash.detail?.includes('path flags'));
	});

	test('parseBangCommands', () => {
		const bangs = parseBangCommands('look `!git status` and !ls -la');
		assert.ok(bangs.length >= 1);
		assert.ok(bangs.some((b) => b.commandLine.includes('git status')));
	});

	test('splitCommandLine', () => {
		assert.deepStrictEqual(splitCommandLine('git status'), {
			command: 'git',
			args: ['status'],
		});
	});

	test('splitIntoTurns', () => {
		const turns = splitIntoTurns([
			{ id: '1', role: 'user', content: 'a' },
			{ id: '2', role: 'assistant', content: 'b' },
			{ id: '3', role: 'user', content: 'c' },
		]);
		assert.strictEqual(turns.length, 2);
	});
});
