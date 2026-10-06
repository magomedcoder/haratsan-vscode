import * as assert from 'node:assert/strict';
import { formatHaratsanRulesForPrompt, MAX_HARATSAN_RULES_CHARS, normalizeHaratsanRulesText } from '../features/project/haratsanRules';

suite('.haratsanrules', () => {
	test('normalizeHaratsanRulesText trims and rejects empty', () => {
		assert.equal(normalizeHaratsanRulesText('   '), undefined);
		assert.equal(normalizeHaratsanRulesText('  hello  '), 'hello');
	});

	test('normalizeHaratsanRulesText truncates long files', () => {
		const long = 'x'.repeat(MAX_HARATSAN_RULES_CHARS + 50);
		const out = normalizeHaratsanRulesText(long);
		assert.ok(out);
		assert.ok(out.length < long.length);
		assert.match(out, /обрезан/);
	});

	test('formatHaratsanRulesForPrompt prefixes content', () => {
		const out = formatHaratsanRulesForPrompt('Use tabs.');
		assert.match(out, /\.haratsanrules/);
		assert.match(out, /Use tabs\./);
	});
});
