/**
 * Опциональный SQLite sidecar для merkle (+ meta) при больших репо.
 * Требует Node `node:sqlite` (22+). При недоступности - мягкий сбой, JSON остаётся каноном.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { indexDirForFolder } from './indexStorage';
import type { MerkleDocument } from './merkle';
import { MERKLE_ALGORITHM, MERKLE_VERSION, parseMerkleJson } from './merkle';

const DB_FILE = 'index.sqlite';

type SqliteDb = {
	exec(sql: string): void;
	prepare(sql: string): {
		run: (...params: unknown[]) => void;
		get: (...params: unknown[]) => Record<string, unknown> | undefined;
	};
	close?: () => void;
};

function tryOpenDb(dbPath: string): SqliteDb | undefined {
	try {
		const mod = require('node:sqlite') as {
			DatabaseSync?: new (path: string) => SqliteDb;
		};

		if (!mod.DatabaseSync) {
			return undefined;
		}

		const db = new mod.DatabaseSync(dbPath);
		db.exec(`
			CREATE TABLE IF NOT EXISTS meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS merkle_blob (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				json TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`);
		return db;
	} catch {
		return undefined;
	}
}

export function isSqliteIndexAvailable(): boolean {
	try {
		const mod = require('node:sqlite');
		return Boolean(mod?.DatabaseSync);
	} catch {
		return false;
	}
}

export async function saveMerkleToSqlite(
	folderFsPath: string,
	doc: MerkleDocument,
): Promise<boolean> {
	const dir = indexDirForFolder(folderFsPath);
	if (!dir) {
		return false;
	}

	fs.mkdirSync(dir, { recursive: true });
	const dbPath = path.join(dir, DB_FILE);
	const db = tryOpenDb(dbPath);
	if (!db) {
		return false;
	}

	try {
		const json = JSON.stringify(doc);
		db.prepare(`INSERT INTO merkle_blob (id, json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).run(json, doc.updatedAt);
		db.prepare(`INSERT INTO meta (key, value) VALUES ('merkle_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(MERKLE_VERSION));
		db.prepare(`INSERT INTO meta (key, value) VALUES ('merkle_algorithm', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(MERKLE_ALGORITHM);
		return true;
	} catch {
		return false;
	} finally {
		try {
			db.close?.();
		} catch {}
	}
}

export async function loadMerkleFromSqlite(folderFsPath: string): Promise<MerkleDocument | undefined> {
	const dir = indexDirForFolder(folderFsPath);
	if (!dir) {
		return undefined;
	}

	const dbPath = path.join(dir, DB_FILE);
	if (!fs.existsSync(dbPath)) {
		return undefined;
	}

	const db = tryOpenDb(dbPath);
	if (!db) {
		return undefined;
	}

	try {
		const row = db.prepare(`SELECT json FROM merkle_blob WHERE id = 1`).get() as | { json?: string } | undefined;
		if (!row?.json || typeof row.json !== 'string') {
			return undefined;
		}

		return parseMerkleJson(row.json);
	} catch {
		return undefined;
	} finally {
		try {
			db.close?.();
		} catch {}
	}
}

export function shouldUseSqliteStorage(
	fileCount: number,
	settings: { indexStorageBackend?: string; indexSqliteMinFiles?: number },
): boolean {
	if (settings.indexStorageBackend !== 'sqlite') {
		return false;
	}

	if (!isSqliteIndexAvailable()) {
		return false;
	}

	const min = typeof settings.indexSqliteMinFiles === 'number' ? settings.indexSqliteMinFiles : 500;
	return fileCount >= min;
}
