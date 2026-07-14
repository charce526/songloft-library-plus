import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const manifest = JSON.parse(readFileSync('plugin.json', 'utf8'));
const artifact = join('dist', `${manifest.entryPath}-v${manifest.version}.jsplugin.zip`);
const result = spawnSync('unzip', ['-t', artifact], { stdio: 'inherit' });

process.exit(result.status ?? 1);
