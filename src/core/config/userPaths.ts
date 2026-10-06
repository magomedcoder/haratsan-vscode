import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Каталог пользовательского конфига Haratsan.
 *
 * - `HARATSAN_CONFIG_DIR` - явный override
 * - Linux: `$XDG_CONFIG_HOME/haratsan` или `~/.config/haratsan`
 * - macOS: `~/.config/haratsan`
 * - Windows: `%APPDATA%/haratsan`
 */

function platformConfigBase(): string {
	if (process.platform === 'win32') {
		return process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming');
	}

	if (process.platform === 'darwin') {
		return path.join(os.homedir(), '.config');
	}

	return process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
}

export function getHaratsanUserConfigDir(): string {
	const override = process.env.HARATSAN_CONFIG_DIR?.trim();
	if (override) {
		return path.resolve(override);
	}

	return path.join(platformConfigBase(), 'haratsan');
}

export function getHaratsanUserConfigPath(): string {
	return path.join(getHaratsanUserConfigDir(), 'config.json');
}

export function getHaratsanUserAgentsPath(): string {
	return path.join(getHaratsanUserConfigDir(), 'AGENTS.md');
}
