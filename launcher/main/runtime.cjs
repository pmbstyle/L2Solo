'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const extract = require('extract-zip');
const tar = require('tar');
const { readJson, writeJson, sha256 } = require('./files.cjs');
const { versionPattern } = require('./releases.cjs');

const executable = platform => platform === 'win32' ? 'node.exe' : 'node';
function targetFor(version, platform = process.platform, arch = process.arch) {
    if (!versionPattern.test(version) || Number(version.split('.')[0]) < 22
        || !['darwin', 'linux', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('Unsupported server Node.js runtime.');
    const basename = `node-v${version}-${platform}-${arch}`;
    return { version, platform, arch, basename, archive: `${basename}.${platform === 'win32' ? 'zip' : 'tar.gz'}` };
}
async function probe(nodePath, version) {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(nodePath, ['-e', "require('node:sqlite'); process.stdout.write(process.versions.node)"],
        { encoding: 'utf8', env, windowsHide: true, timeout: 15000 });
    if (version && stdout.trim() !== version) throw new Error(`Expected Node.js ${version}, found ${stdout.trim()}.`);
    return stdout.trim();
}

async function prepareRuntime(destination, { version, platform = process.platform, arch = process.arch, fetcher = fetch, progress = () => {} }) {
    const target = targetFor(version, platform, arch);
    const base = `https://nodejs.org/dist/v${version}`;
    await fs.promises.mkdir(destination, { recursive: true });
    const temporary = await fs.promises.mkdtemp(path.join(path.dirname(destination), '.node-download-'));
    try {
        const sums = await fetcher(`${base}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30000) });
        if (!sums.ok) throw new Error(`Cannot fetch Node.js checksums (HTTP ${sums.status}).`);
        const text = await sums.text();
        if (text.length > 1024 ** 2) throw new Error('Node.js checksum list is too large.');
        const checksum = text.split('\n').map(line => line.trim().split(/\s+/)).find(row => row[1] === target.archive)?.[0];
        if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Node.js runtime checksum not found.');
        const response = await fetcher(`${base}/${target.archive}`, { signal: AbortSignal.timeout(180000) });
        if (!response.ok) throw new Error(`Cannot download Node.js (HTTP ${response.status}).`);
        const archive = path.join(temporary, target.archive);
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        const meter = new Transform({ transform(chunk, encoding, callback) {
            bytes += chunk.length;
            if (bytes > 512 * 1024 ** 2) return callback(new Error('Node.js runtime archive is too large.'));
            hash.update(chunk);
            progress(bytes, Number(response.headers.get('content-length')) || 0);
            callback(null, chunk);
        } });
        await pipeline(response.body, meter, fs.createWriteStream(archive, { flags: 'wx' }));
        if (hash.digest('hex') !== checksum) throw new Error('Node.js runtime checksum mismatch.');
        const nodeMember = `${target.basename}/${platform === 'win32' ? 'node.exe' : 'bin/node'}`;
        const licenseMember = `${target.basename}/LICENSE`;
        if (platform === 'win32') await extract(archive, { dir: temporary, onEntry(entry) {
            if (entry.fileName.includes('..') || entry.fileName.includes('\\')
                || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('Unsafe Node.js archive entry.');
        } });
        else await tar.x({ file: archive, cwd: temporary, strict: true,
            filter: (name, entry) => [nodeMember, licenseMember].includes(name) && entry.type === 'File' });
        const nodePath = path.join(destination, executable(platform));
        await fs.promises.copyFile(path.join(temporary, nodeMember), nodePath);
        await fs.promises.chmod(nodePath, 0o755);
        await fs.promises.copyFile(path.join(temporary, licenseMember), path.join(destination, 'NODE-LICENSE'));
        await probe(nodePath, version);
        await writeJson(path.join(destination, 'runtime.json'), { ...target, sha256: checksum, executableSha256: await sha256(nodePath) });
        return nodePath;
    } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
}

class RuntimeManager {
    constructor({ userData, bundledNode, fetcher = fetch, defaultVersion = require('../package.json').serverRuntimeVersion }) {
        this.directory = path.join(userData, 'runtimes');
        this.bundledNode = bundledNode;
        this.fetcher = fetcher;
        this.defaultVersion = defaultVersion;
        this.pending = new Map();
    }
    async ensure(version, progress = () => {}) {
        version ||= this.defaultVersion;
        targetFor(version);
        if (this.pending.has(version)) return this.pending.get(version);
        const work = this.prepare(version, progress);
        this.pending.set(version, work);
        try { return await work; } finally { this.pending.delete(version); }
    }
    async prepare(version, progress) {
        const target = targetFor(version);
        const directory = path.join(this.directory, `${version}-${target.platform}-${target.arch}`);
        const nodePath = path.join(directory, executable(target.platform));
        try {
            const metadata = await readJson(path.join(directory, 'runtime.json'));
            if (metadata?.version === version && metadata.platform === target.platform && metadata.arch === target.arch
                && metadata.executableSha256 === await sha256(nodePath)) {
                await probe(nodePath, version);
                return nodePath;
            }
        } catch { /* Repair a missing or damaged private runtime. */ }
        await fs.promises.mkdir(this.directory, { recursive: true });
        const stage = await fs.promises.mkdtemp(path.join(this.directory, '.runtime-'));
        try {
            let bundledVersion;
            try { bundledVersion = await probe(this.bundledNode); } catch { /* Download a replacement below. */ }
            if (bundledVersion === version) {
                const stagedNode = path.join(stage, executable(target.platform));
                await fs.promises.copyFile(this.bundledNode, stagedNode);
                await fs.promises.chmod(stagedNode, 0o755);
                await probe(stagedNode, version);
                const license = path.join(path.dirname(this.bundledNode), 'NODE-LICENSE');
                if (fs.existsSync(license)) await fs.promises.copyFile(license, path.join(stage, 'NODE-LICENSE'));
                await writeJson(path.join(stage, 'runtime.json'), { ...target, executableSha256: await sha256(stagedNode) });
            } else {
                progress({ label: `Downloading Node.js ${version}`, percent: 2 });
                await prepareRuntime(stage, { version, fetcher: this.fetcher, progress: (bytes, total) =>
                    progress({ label: `Downloading Node.js ${version}`, percent: total ? bytes / total * 3 : 2, bytes, total }) });
            }
            await fs.promises.rm(directory, { recursive: true, force: true });
            await fs.promises.rename(stage, directory);
            return nodePath;
        } finally { await fs.promises.rm(stage, { recursive: true, force: true }); }
    }
}

module.exports = { RuntimeManager, prepareRuntime, probe, targetFor };
