import { readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync('plugin.json', 'utf8'));
const source = join('dist', `${manifest.entryPath}.jsplugin.zip`);
const target = join('dist', `${manifest.entryPath}-v${manifest.version}.jsplugin.zip`);

renameSync(source, target);
console.log(`版本化安装包：${target}`);
