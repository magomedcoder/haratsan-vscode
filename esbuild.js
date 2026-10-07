const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const TREE_SITTER_COPY = new Set([
	'tree-sitter.wasm',
	'tree-sitter.js',
	'web-tree-sitter.d.ts',
	'tree-sitter-typescript.wasm',
	'tree-sitter-tsx.wasm',
	'tree-sitter-javascript.wasm',
	'tree-sitter-python.wasm',
	'tree-sitter-go.wasm',
	'tree-sitter-rust.wasm',
	'tree-sitter-java.wasm',
	'tree-sitter-cpp.wasm',
	'tree-sitter-c-sharp.wasm',
	'tree-sitter-ruby.wasm',
	'tree-sitter-php.wasm',
	'tree-sitter-bash.wasm',
	'tree-sitter-css.wasm',
]);

function copyTreeSitterWasm() {
	const srcDir = path.join(__dirname, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm');
	const destDir = path.join(__dirname, 'dist', 'tree-sitter');
	if (!fs.existsSync(srcDir)) {
		console.warn('[esbuild] @vscode/tree-sitter-wasm не найден; Tree-sitter будет отключён в runtime');
		return;
	}

	const copySet = new Set(TREE_SITTER_COPY);
	for (const name of String(process.env.TREE_SITTER_EXTRA || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)) {
		copySet.add(name.endsWith('.wasm') ? name : `tree-sitter-${name}.wasm`);
	}

	fs.mkdirSync(destDir, { recursive: true });
	for (const name of fs.readdirSync(srcDir)) {
		if (!copySet.has(name)) {
			continue;
		}
		fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name));
	}
}

/**
 * @param {string} name
 * @returns {import('esbuild').Plugin}
 */
function createProblemMatcherPlugin(name) {
	return {
		name: 'esbuild-problem-matcher',
		setup(build) {
			build.onStart(() => {
				if (activeBuilds.size === 0) {
					console.log('[watch] build started');
				}
				activeBuilds.add(name);
			});

			build.onEnd((result) => {
				result.errors.forEach(({ text, location }) => {
					console.error(`✘ [ERROR] ${text}`);
					if (location) {
						console.error(`    ${location.file}:${location.line}:${location.column}:`);
					}
				});

				activeBuilds.delete(name);
				if (activeBuilds.size === 0) {
					console.log('[watch] build finished');
				}
			});
		},
	};
}

/** @type {Set<string>} */
const activeBuilds = new Set();

async function createExtensionContext() {
	return esbuild.context({
		entryPoints: ['src/extension.ts'],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [createProblemMatcherPlugin('extension')],
	});
}

async function createWebviewContext() {
	return esbuild.context({
		entryPoints: ['src/webview/index.tsx'],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		outdir: 'dist/webview',
		logLevel: 'silent',
		loader: {
			'.css': 'css',
		},
		plugins: [createProblemMatcherPlugin('webview')],
	});
}

async function main() {
	const [extensionCtx, webviewCtx] = await Promise.all([
		createExtensionContext(),
		createWebviewContext(),
	]);

	copyTreeSitterWasm();

	if (watch) {
		await extensionCtx.watch();
		await webviewCtx.watch();
		return;
	}

	await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
	copyTreeSitterWasm();
	await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
