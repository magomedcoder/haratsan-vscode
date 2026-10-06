import * as fs from 'node:fs/promises';
import { INDEX_MANIFEST_FILE, indexDirForFolder, indexFilePath, isIndexStorageAvailable } from './indexStorage';
import { needsManifestRepair, parseManifestJson, repairManifestInMemory } from './manifestParse';
import type { ManifestRepairReason } from './manifestParse';
import { emptyManifest } from './types';
import type { IndexManifest } from './types';

function manifestPathForFolder(folderFsPath: string): string | undefined {
	return indexFilePath(folderFsPath, INDEX_MANIFEST_FILE);
}

async function ensureIndexDir(folderFsPath: string): Promise<boolean> {
	const dir = indexDirForFolder(folderFsPath);
	if (!dir) {
		return false;
	}
	
	await fs.mkdir(dir, { recursive: true });
	return true;
}

export async function loadManifest(folderFsPath: string): Promise<IndexManifest> {
	const file = manifestPathForFolder(folderFsPath);
	if (!file) {
		return emptyManifest();
	}

	try {
		const raw = await fs.readFile(file, 'utf8');
		const parsed = parseManifestJson(raw);
		if (!parsed.ok) {
			return emptyManifest();
		}

		// Отсутствующие digests не чиним на каждом load - только при явном repair
		return parsed.manifest;
	} catch {
		return emptyManifest();
	}
}

// Проверить манифест на диске: corrupt / missing digests (для UI Repair)
export async function inspectManifest(folderFsPath: string): Promise<{
	exists: boolean;
	corrupt: boolean;
	missingDirDigests: boolean;
	repairReason?: ManifestRepairReason;
	manifest: IndexManifest;
	storageAvailable: boolean;
}> {
	if (!isIndexStorageAvailable()) {
		return {
			exists: false,
			corrupt: false,
			missingDirDigests: false,
			manifest: emptyManifest(),
			storageAvailable: false,
		};
	}

	const file = manifestPathForFolder(folderFsPath);
	if (!file) {
		return {
			exists: false,
			corrupt: false,
			missingDirDigests: false,
			manifest: emptyManifest(),
			storageAvailable: false,
		};
	}

	try {
		const raw = await fs.readFile(file, 'utf8');
		const parsed = parseManifestJson(raw);
		if (!parsed.ok) {
			return {
				exists: true,
				corrupt: true,
				missingDirDigests: false,
				repairReason: parsed.reason,
				manifest: emptyManifest(),
				storageAvailable: true,
			};
		}

		return {
			exists: true,
			corrupt: false,
			missingDirDigests: parsed.missingDirDigests,
			repairReason: parsed.missingDirDigests ? 'missing_dir_digests' : undefined,
			manifest: parsed.manifest,
			storageAvailable: true,
		};
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code === 'ENOENT') {
			return {
				exists: false,
				corrupt: false,
				missingDirDigests: false,
				manifest: emptyManifest(),
				storageAvailable: true,
			};
		}

		return {
			exists: true,
			corrupt: true,
			missingDirDigests: false,
			repairReason: 'invalid_json',
			manifest: emptyManifest(),
			storageAvailable: true,
		};
	}
}

/**
 * Починить corrupt / missing-dirDigests манифест на диске.
 * Битый JSON -> emptyManifest; missing digests -> recompute; затем save.
 */
export async function repairManifestFile(folderFsPath: string): Promise<{
	repaired: boolean;
	reason: ManifestRepairReason | 'ok' | 'missing' | 'no_storage';
	manifest: IndexManifest;
}> {
	if (!isIndexStorageAvailable()) {
		return {
			repaired: false,
			reason: 'no_storage',
			manifest: emptyManifest(),
		};
	}

	const file = manifestPathForFolder(folderFsPath);
	if (!file) {
		return {
			repaired: false,
			reason: 'no_storage',
			manifest: emptyManifest(),
		};
	}

	try {
		const raw = await fs.readFile(file, 'utf8');
		const parsed = parseManifestJson(raw);
		if (!needsManifestRepair(parsed)) {
			return {
				repaired: false,
				reason: 'ok',
				manifest: parsed.ok ? parsed.manifest : emptyManifest(),
			};
		}

		const { manifest, reason } = repairManifestInMemory(parsed);
		await saveManifest(folderFsPath, manifest);
		return {
			repaired: true,
			reason,
			manifest,
		};
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code === 'ENOENT') {
			const manifest = emptyManifest();
			await saveManifest(folderFsPath, manifest);
			return {
				repaired: true,
				reason: 'missing',
				manifest,
			};
		}

		const manifest = emptyManifest();
		await saveManifest(folderFsPath, manifest);
		return {
			repaired: true,
			reason: 'invalid_json',
			manifest,
		};
	}
}

export async function saveManifest(folderFsPath: string, manifest: IndexManifest): Promise<void> {
	const ok = await ensureIndexDir(folderFsPath);
	const file = manifestPathForFolder(folderFsPath);
	if (!ok || !file) {
		throw new Error('Index storage unavailable (no workspace storageUri)');
	}

	manifest.updatedAt = new Date().toISOString();
	await fs.writeFile(file, JSON.stringify(manifest, null, 2), 'utf8');
}
