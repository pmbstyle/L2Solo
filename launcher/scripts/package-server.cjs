'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const archiver = require('archiver');
const { sha256, managedPath, writeJson } = require('../main/files.cjs');
const { validateManifest, requiredServerFiles } = require('../main/releases.cjs');
const { plan } = require('./release-plan.cjs');

const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.L2SOLO_RELEASE_OUTPUT || path.join(root, 'launcher/dist/server'));

async function collect(directory, base, files = []) {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(base, absolute).split(path.sep).join('/');
        if (relative === 'node_modules/.bin' || entry.name === '.DS_Store') continue;
        if (entry.isSymbolicLink()) throw new Error(`Release cannot contain symbolic links: ${relative}`);
        if (entry.isDirectory()) await collect(absolute, base, files);
        else if (entry.isFile()) files.push({ path: managedPath(relative), bytes: (await fs.promises.stat(absolute)).size, sha256: await sha256(absolute) });
    }
    return files;
}

async function main() {
    const pkg = require(path.join(root, 'package.json'));
    const tag = process.env.RELEASE_TAG || `server-v${pkg.version}`;
    const release = plan(tag);
    if (release.component !== 'server') throw new Error('A server tag is required.');
    await fs.promises.mkdir(output, { recursive: true });
    const stage = await fs.promises.mkdtemp(path.join(output, '.server-'));
    try {
        // Git's allowlist excludes live worlds, local keys, geodata and backups.
        const tracked = execFileSync('git', ['ls-files', '-z', '--', 'src', 'scripts', 'data', 'database',
            'config/default.ini', 'config/local.example.ini', 'package.json', 'package-lock.json', 'LICENSE', 'README.md'], { cwd: root }).toString().split('\0').filter(Boolean);
        // Explicit public entry points and the lockfile also support a local
        // pre-commit build; arbitrary untracked files are never included.
        for (const required of [...requiredServerFiles, 'package-lock.json']) if (!tracked.includes(required)) tracked.push(required);
        for (const relative of tracked) {
            if (relative.endsWith('.DS_Store')) continue;
            managedPath(relative);
            if (!(await fs.promises.lstat(path.join(root, relative))).isFile()) throw new Error(`Not a regular release file: ${relative}`);
            const target = path.join(stage, relative);
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            await fs.promises.copyFile(path.join(root, relative), target);
        }
        const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const installed = spawnSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
            cwd: stage, stdio: 'inherit', shell: process.platform === 'win32'
        });
        if (installed.status !== 0) throw new Error('Server dependencies could not be installed.');
        const files = (await collect(stage, stage)).sort((a, b) => a.path.localeCompare(b.path));
        const name = `L2Solo-Server-v${pkg.version}.zip`;
        const archivePath = path.join(output, name);
        await new Promise((resolve, reject) => {
            const stream = fs.createWriteStream(archivePath);
            const zip = archiver('zip', { zlib: { level: 9 } });
            stream.on('close', resolve);
            stream.on('error', reject);
            zip.on('error', reject);
            zip.on('warning', reject);
            zip.pipe(stream);
            for (const file of files) zip.file(path.join(stage, file.path), { name: file.path, mode: 0o644 });
            zip.finalize().catch(reject);
        });
        const migrations = [...(await fs.promises.readFile(path.join(stage, 'src/Database.js'), 'utf8')).matchAll(/migrations\.push\(\[(\d+),/g)].map(match => Number(match[1]));
        if (!migrations.length) throw new Error('Cannot determine the packaged database schema version.');
        const manifest = validateManifest({ schemaVersion: 2, component: 'server', tag, version: pkg.version, channel: release.channel,
            sourceCommit: process.env.RELEASE_SOURCE_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
            databaseSchemaVersion: Math.max(...migrations), startupProtocolVersion: 2,
            minimumLauncherVersion: pkg.l2soloRelease.minimumLauncherVersion, runtime: { version: pkg.l2soloRelease.runtimeVersion },
            archive: { name, bytes: (await fs.promises.stat(archivePath)).size, sha256: await sha256(archivePath) }, files }, tag);
        await writeJson(path.join(output, 'l2solo-release.json'), manifest);
        console.log(`Packaged ${tag}: ${files.length} verified files, ${(manifest.archive.bytes / 1024 ** 2).toFixed(1)} MB`);
    } finally { await fs.promises.rm(stage, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
