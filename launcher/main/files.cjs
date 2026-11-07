'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { holdLock } = require('./locks.cjs');

async function readJson(file, fallback = null) {
    try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function writeJson(file, value) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
        await fs.promises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        await fs.promises.rename(temporary, file);
    } finally { await fs.promises.rm(temporary, { force: true }); }
}

async function sha256(file) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

function canonicalPath(file) {
    const absolute = path.resolve(file);
    try { return fs.realpathSync(absolute); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = path.dirname(absolute);
        if (parent === absolute) throw error;
        return path.join(canonicalPath(parent), path.basename(absolute));
    }
}

function managedPath(name) {
    if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':')
        || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..')
        || /[\x00-\x1f]/.test(name) || name.split('/').some(part => /[. ]$/.test(part))
        || name.split('/').some(part => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
        throw new Error(`Unsafe release path: ${name}`);
    }
    const allowed = /^(src|scripts|database|node_modules)\//.test(name)
        || (/^data\//.test(name) && !/^data\/([.]|geodata(?:[/.]|$))/i.test(name))
        || ['config/default.ini', 'config/local.example.ini', 'package.json', 'package-lock.json', 'LICENSE', 'README.md'].includes(name);
    if (!allowed || /\.(sqlite(?:-wal|-shm)?|db|DS_Store)$/i.test(name)) {
        throw new Error(`Release cannot replace user data: ${name}`);
    }
    return name;
}

// Never follow links in an existing installation while replacing release files.
async function safeDestination(root, relative) {
    managedPath(relative);
    let current = root;
    for (const part of relative.split('/')) {
        current = path.join(current, part);
        try {
            if ((await fs.promises.lstat(current)).isSymbolicLink()) throw new Error(`Move this symbolic link before updating: ${current}`);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return current;
}

async function acquireLock(root, nodePath = process.execPath) {
    // OS-backed SQLite locking is atomic across processes and releases on a
    // crash. There is no stale PID-file reclamation race on Windows or Unix.
    return holdLock(path.join(root, '.l2solo', 'operation'), nodePath,
        'Another launcher is using this installation. Close it before continuing.');
}

module.exports = { readJson, writeJson, sha256, canonicalPath, managedPath, safeDestination, acquireLock };
