'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const extract = require('extract-zip');
const tar = require('tar');

const version = '22.23.0';
const root = path.resolve(__dirname, '..');

async function main() {
    if (!['darwin', 'linux', 'win32'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new Error('Unsupported runtime platform.');
    const basename = `node-v${version}-${process.platform}-${process.arch}`;
    const filename = `${basename}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
    const baseUrl = `https://nodejs.org/dist/v${version}`;
    const sums = await fetch(`${baseUrl}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30000) });
    if (!sums.ok) throw new Error(`Cannot fetch Node.js checksums: ${sums.status}`);
    const checksum = (await sums.text()).split('\n').map(line => line.trim().split(/\s+/)).find(row => row[1] === filename)?.[0];
    if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Node.js runtime checksum not found.');
    const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'l2solo-runtime-'));
    try {
        const response = await fetch(`${baseUrl}/${filename}`, { signal: AbortSignal.timeout(180000) });
        if (!response.ok) throw new Error(`Cannot download Node.js: ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== checksum) throw new Error('Node.js runtime checksum mismatch.');
        const archive = path.join(temporary, filename);
        await fs.promises.writeFile(archive, bytes);
        if (process.platform === 'win32') await extract(archive, { dir: temporary });
        else await tar.x({ file: archive, cwd: temporary, strict: true, filter: name =>
            name === basename || name === `${basename}/bin` || name === `${basename}/bin/node` || name === `${basename}/LICENSE` });
        const runtime = path.join(root, 'runtime');
        await fs.promises.mkdir(runtime, { recursive: true });
        const target = path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'node');
        await fs.promises.copyFile(path.join(temporary, basename, process.platform === 'win32' ? 'node.exe' : 'bin/node'), target);
        await fs.promises.chmod(target, 0o755);
        await fs.promises.copyFile(path.join(temporary, basename, 'LICENSE'), path.join(runtime, 'NODE-LICENSE'));
        await fs.promises.writeFile(path.join(runtime, 'runtime.json'), `${JSON.stringify({ version, platform: process.platform, arch: process.arch, archive: filename, sha256: checksum }, null, 2)}\n`);
        const check = spawnSync(target, ['-e', "require('node:sqlite'); console.log(process.version)"], { encoding: 'utf8' });
        if (check.status !== 0) throw new Error(check.stderr || 'Node.js SQLite smoke check failed.');
        console.log(`Bundled Node.js ${check.stdout.trim()} (${process.platform}/${process.arch})`);
    } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
