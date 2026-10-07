import { contentHash } from './hash';
import type { IndexFileRecord, IndexManifest } from './types';

// Родительский каталог POSIX-пути ('' = корень workspace)
export function parentDir(relativePath: string): string {
	const norm = relativePath.replace(/\\/g, '/').replace(/\/+$/, '');
	const idx = norm.lastIndexOf('/');
	if (idx <= 0) {
		return '';
	}

	return norm.slice(0, idx);
}

// Все предки пути, от ближайшего к корню (включая '')
export function ancestorDirs(relativePath: string): string[] {
	const out: string[] = [];
	let cur = parentDir(relativePath);
	for (;;) {
		out.push(cur);
		if (!cur) {
			break;
		}

		cur = parentDir(cur);
	}

	return out;
}

function depthOf(dir: string): number {
	if (!dir) {
		return 0;
	}

	return dir.split('/').filter(Boolean).length;
}

// Merkle / dir-level digests: path -> hash прямых детей (файл -> contentHash; подкаталог -> его digest).
export function recomputeDirDigests(files: Record<string, Pick<IndexFileRecord, 'hash'>>): Record<string, string> {
	// Каталог -> (имя_ребёнка -> { kind, hash? })
	type Child = { 
		kind: 'file'; 
		hash: string 
	} | { kind: 'dir' };
	const children = new Map<string, Map<string, Child>>();

	const ensureDir = (dir: string): Map<string, Child> => {
		let map = children.get(dir);
		if (!map) {
			map = new Map();
			children.set(dir, map);
		}

		return map;
	};

	ensureDir('');

	for (const [relative, record] of Object.entries(files)) {
		const norm = relative.replace(/\\/g, '/');
		const parts = norm.split('/').filter(Boolean);
		if (parts.length === 0) {
			continue;
		}

		// Промежуточные каталоги
		for (let i = 0; i < parts.length - 1; i += 1) {
			const parent = parts.slice(0, i).join('/');
			const name = parts[i]!;
			const map = ensureDir(parent);
			if (!map.has(name)) {
				map.set(name, { kind: 'dir' });
			}
			ensureDir(parts.slice(0, i + 1).join('/'));
		}

		const parent = parts.slice(0, -1).join('/');
		const name = parts[parts.length - 1]!;
		ensureDir(parent).set(name, { kind: 'file', hash: record.hash });
	}

	const dirs = [...children.keys()].sort((a, b) => depthOf(b) - depthOf(a));
	const digests: Record<string, string> = {};

	for (const dir of dirs) {
		const map = children.get(dir)!;
		const lines: string[] = [];
		for (const name of [...map.keys()].sort()) {
			const child = map.get(name)!;
			if (child.kind === 'file') {
				lines.push(`f:${name}:${child.hash}`);
			} else {
				const childPath = dir ? `${dir}/${name}` : name;
				const childDigest = digests[childPath] ?? '';
				lines.push(`d:${name}:${childDigest}`);
			}
		}

		digests[dir] = contentHash(lines.join('\n'));
	}

	return digests;
}

// Записать digests в manifest (in-place)
export function applyDirDigests(manifest: IndexManifest): void {
	manifest.dirDigests = recomputeDirDigests(manifest.files);
}

// Прямой потомок каталога для пропуска Merkle (одного size недостаточно).
export type DirRewalkChild = {
	relative: string;
	size: number;
	// Уже проверенный content-hash (или доверенный через size+mtime gate).
	contentHash?: string;
	mtimeMs?: number;
};

/**
 * Пропустить перечитывание/rechunk прямых детей `dir`, если:
 * - есть dirDigest;
 * - набор путей совпадает;
 * - у каждого файла совпадает content-hash (явно или через size+mtime <-> record).
 * Path+size без hash/mtime - недостаточно (контент мог смениться при том же размере).
 */
export function canSkipDirRewalk(
	manifest: IndexManifest,
	dir: string,
	filesUnderDir: ReadonlyArray<DirRewalkChild>,
	opts?: { forceContentHash?: boolean },
): boolean {
	if (!manifest.dirDigests?.[dir]) {
		return false;
	}

	const prevPaths = Object.keys(manifest.files)
		.filter((p) => parentDir(p) === dir)
		.sort();
	const nowPaths = [...filesUnderDir].map((f) => f.relative).sort();
	if (prevPaths.length !== nowPaths.length || prevPaths.length === 0) {
		return false;
	}

	const childByPath = new Map(filesUnderDir.map((f) => [f.relative, f]));
	for (let i = 0; i < prevPaths.length; i += 1) {
		const relative = prevPaths[i]!;
		if (relative !== nowPaths[i]) {
			return false;
		}

		const record = manifest.files[relative];
		const child = childByPath.get(relative);
		if (!record || !child || child.size !== record.size) {
			return false;
		}

		if (child.contentHash) {
			if (child.contentHash !== record.hash) {
				return false;
			}

			continue;
		}

		// Жёсткий режим: без явного content-hash не пропускать (mtime ненадёжен)
		if (opts?.forceContentHash) {
			return false;
		}

		// Без явного hash - только size+mtime (доверенный сохранённый content-hash)
		if (
			child.mtimeMs === undefined ||
			record.mtimeMs === undefined ||
			child.mtimeMs !== record.mtimeMs
		) {
			return false;
		}
	}

	return true;
}
