import { applyDirDigests } from './dirDigests';
import { emptyManifest, INDEX_MANIFEST_VERSION, INDEX_MANIFEST_VERSIONS_ACCEPTED } from './types';
import type { IndexManifest } from './types';

// Причина, по которой манифест нужно чинить
export type ManifestRepairReason = | 'invalid_json'
	| 'not_object'
	| 'bad_version'
	| 'missing_dir_digests';

export type ManifestParseOk = {
	ok: true;
	manifest: IndexManifest;
	// Есть файлы/чанки, но dirDigests пустой или отсутствует - нужен recompute
	missingDirDigests: boolean;
};

export type ManifestParseFail = {
	ok: false;
	reason: Exclude<ManifestRepairReason, 'missing_dir_digests'>;
};

export type ManifestParseResult = ManifestParseOk | ManifestParseFail;

/**
 * Чистый разбор JSON манифеста (без I/O).
 * Битый JSON / неверный version -> fail; иначе ok (+ флаг missingDirDigests).
 */
export function parseManifestJson(raw: string): ManifestParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			ok: false,
			reason: 'invalid_json'
		};
	}

	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return {
			ok: false,
			reason: 'not_object'
		};
	}

	const obj = parsed as Partial<IndexManifest>;
	if (typeof obj.version !== 'number' || !INDEX_MANIFEST_VERSIONS_ACCEPTED.has(obj.version)) {
		return {
			ok: false,
			reason: 'bad_version'
		};
	}

	const files = obj.files && typeof obj.files === 'object' && !Array.isArray(obj.files) ? obj.files : {};
	const chunks = obj.chunks && typeof obj.chunks === 'object' && !Array.isArray(obj.chunks) ? obj.chunks : {};
	const trigrams = obj.trigrams && typeof obj.trigrams === 'object' && !Array.isArray(obj.trigrams)
		? obj.trigrams
		: {};
	const hasDirDigestsField =
		obj.dirDigests !== undefined &&
		obj.dirDigests !== null &&
		typeof obj.dirDigests === 'object' &&
		!Array.isArray(obj.dirDigests);
	const dirDigests = hasDirDigestsField ? (obj.dirDigests as Record<string, string>) : {};

	const fileCount = Object.keys(files).length;
	const digestCount = Object.keys(dirDigests).length;
	// Пустой индекс без digests - норма; иначе нет digests -> нужен repair/recompute
	const missingDirDigests = fileCount > 0 && (!hasDirDigestsField || digestCount === 0);

	const manifest: IndexManifest = {
		version: INDEX_MANIFEST_VERSION,
		updatedAt:
			typeof obj.updatedAt === 'string' && obj.updatedAt
				? obj.updatedAt
				: new Date(0).toISOString(),
		files: files as IndexManifest['files'],
		chunks: chunks as IndexManifest['chunks'],
		trigrams: trigrams as IndexManifest['trigrams'],
		dirDigests,
	};

	return { ok: true, manifest, missingDirDigests };
}

// Нужен ли repair (битый JSON / version / нет digests)
export function needsManifestRepair(result: ManifestParseResult): boolean {
	if (!result.ok) {
		return true;
	}
	return result.missingDirDigests;
}

/**
 * Починить in-memory манифест:
 * - corrupt -> emptyManifest
 * - missing dirDigests -> applyDirDigests
 */
export function repairManifestInMemory(result: ManifestParseResult): {
	manifest: IndexManifest;
	reason: ManifestRepairReason | 'ok';
} {
	if (!result.ok) {
		return {
			manifest: emptyManifest(),
			reason: result.reason
		};
	}

	if (result.missingDirDigests) {
		const copy: IndexManifest = {
			...result.manifest,
			files: { ...result.manifest.files },
			chunks: { ...result.manifest.chunks },
			trigrams: { ...result.manifest.trigrams },
			dirDigests: { ...result.manifest.dirDigests },
		};
		applyDirDigests(copy);
		return {
			manifest: copy,
			reason: 'missing_dir_digests'
		};
	}

	return {
		manifest: result.manifest,
		reason: 'ok'
	};
}

// Флаг отмены fullIndex (без DOM AbortController - удобно тестировать)
export class IndexAbortFlag {
	private _aborted = false;

	abort(): void {
		this._aborted = true;
	}

	get aborted(): boolean {
		return this._aborted;
	}

	// Бросить AbortError, если отмена уже запрошена
	throwIfAborted(): void {
		if (this._aborted) {
			throw createIndexAbortError();
		}
	}
}

export function createIndexAbortError(message = 'Индексация отменена'): Error {
	const err = new Error(message);
	err.name = 'AbortError';
	return err;
}

export function isIndexAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === 'AbortError';
}

// Сводка частичных ошибок для lastError (короткая строка в UI)
export function summarizePartialErrors(errors: string[], max = 3): string {
	if (errors.length === 0) {
		return '';
	}
	
	const head = errors.slice(0, max).join('; ');
	if (errors.length <= max) {
		return `Частичные ошибки индекса (${errors.length}): ${head}`;
	}

	return `Частичные ошибки индекса (${errors.length}): ${head}; ...+${errors.length - max}`;
}
