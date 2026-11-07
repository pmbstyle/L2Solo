'use strict';

const { isMainThread } = require('node:worker_threads');
const { createHash, randomBytes } = require('node:crypto');
const Rates = require('../../ProgressionRates');
let initialized = false, metadata = null, lastProfile = null, identity = null;
const digest = value => createHash('sha256').update(value).digest('hex');
const SHA = /^[a-f0-9]{40}$/;

// The identity of the code, config and rates a decision proof was built under
// (EconomyContext.captureEventProof). A held build is served only under the
// identity it was built with. local: the code has no published identity (a
// branch checkout, or no checkout and no install marker): the identity is this process's own (main
// makes it, the worker gets it with the rest, ColdSimulationCoordinator), so
// held builds hold within the process, but no proof outlives it (restorable).
function configure(value) {
    initialized = true;
    metadata = value && SHA.test(value.code) && /^[a-f0-9]{64}$/.test(value.config)
        ? Object.freeze({ code: value.code, config: value.config, local: value.local === true }) : null;
    lastProfile = null; identity = null;
}

function published() {
    if (!initialized && isMainThread) {
        initialized = true;
        // lazy: worker never reads a filesystem or a Git checkout. The code's
        // identity: a detached checkout's commit, else the commit a launcher
        // install was packaged from (its .l2solo/installation.json,
        // launcher/main/installer.cjs); a branch or test tree has only this
        // process's identity (local).
        const fs = require('node:fs'), path = require('node:path');
        const root = path.resolve(__dirname, '../../../..');
        const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; } };
        let code = null, source = 'git';
        try {
            const git = path.join(root, '.git');
            const pointer = fs.statSync(git).isDirectory() ? git
                : path.resolve(root, fs.readFileSync(git, 'utf8').trim().replace(/^gitdir:\s*/, ''));
            code = read(path.join(pointer, 'HEAD'))?.trim() ?? null;
        } catch (_) {
            source = 'install';
            try { code = JSON.parse(read(path.join(root, '.l2solo', 'installation.json')) || 'null')?.sourceCommit ?? null; }
            catch (_) { code = null; }
        }
        const config = globalThis.options?.default;
        const local = !SHA.test(code);
        configure(config && typeof config === 'object'
            ? { code: local ? randomBytes(20).toString('hex') : code, config: digest(JSON.stringify(config)), local } : null);
        // Observable: a layout or manifest change that loses the identity would
        // otherwise silently drop every restart proof (held builds stay in-process).
        globalThis.utils?.infoSuccess?.('Recompute', 'code identity: %s', local ? 'local (no restart proofs)'
            : `${source} ${code.slice(0, 9)}`);
    }
    return metadata;
}

function current() {
    const value = published();
    if (!value) return null;
    const profile = Rates.profile();
    if (profile !== lastProfile) {
        identity = digest(JSON.stringify([value.code, value.config, profile]));
        lastProfile = profile;
    }
    return identity;
}

// The identity a proof saved for a restart is written and read under; null
// for a local identity, which no later process shares.
function restorable() {
    const value = current();
    return value && !metadata.local ? value : null;
}

module.exports = { configure, metadata: published, current, restorable };
