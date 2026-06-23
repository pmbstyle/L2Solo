const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const roots = ['src', 'scripts', 'tests'];
const ignoreDirs = new Set(['node_modules', '.git']);

function collectJsFiles(dir, files = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ignoreDirs.has(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectJsFiles(fullPath, files);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            files.push(fullPath);
        }
    }

    return files;
}

const files = roots
    .filter((root) => fs.existsSync(root))
    .flatMap((root) => collectJsFiles(root))
    .sort();

for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
        cwd: process.cwd(),
        stdio: 'inherit'
    });

    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}

console.log(`Syntax check passed for ${files.length} JavaScript files`);
