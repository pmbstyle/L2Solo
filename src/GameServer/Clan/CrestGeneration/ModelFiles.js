const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const extractZip = require('extract-zip');

const MODEL_VERSION = 'tessera-small-onnx-v1';
const ARCHIVE = {
    name: `${MODEL_VERSION}.zip`,
    url: `https://l2solo.com/models/${MODEL_VERSION}.zip`,
    bytes: 271748325,
    sha256: '463acc65239e2042868c61fbc85f91b8f6123947909eb47c442e19be3abc9566'
};
const MANIFEST = {
    bytes: 1323,
    sha256: 'd0775708dc32bfb0bf58b0e0ed566188ab07a48e0501c20773852c4d81c36656'
};
const CONTENTS = new Set([
    'ATTRIBUTION.txt', 'LICENSE-CLIP.txt', 'LICENSE-Tessera.txt', 'clip.onnx',
    'palette.json', 'tessera.onnx', 'tokenizer.json', 'tokenizer_config.json', 'manifest.json'
]);

async function hasSize(file, bytes) {
    let stat;
    try { stat = await fs.promises.lstat(file); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    return stat.isFile() && stat.size === bytes;
}

async function validModelFiles(directory, signal) {
    const manifest = path.join(directory, 'manifest.json');
    if (!(await hasSize(manifest, MANIFEST.bytes))) return false;
    const data = await fs.promises.readFile(manifest, { signal });
    if (createHash('sha256').update(data).digest('hex') !== MANIFEST.sha256) return false;
    const { files } = JSON.parse(data);
    for (const [name, spec] of Object.entries(files)) {
        if (!(await validFile(path.join(directory, name), spec, signal))) return false;
    }
    return true;
}

async function validFile(file, { bytes, sha256 }, signal) {
    if (!(await hasSize(file, bytes))) return false;
    const digest = createHash('sha256');
    for await (const chunk of fs.createReadStream(file, { signal })) digest.update(chunk);
    return digest.digest('hex') === sha256;
}

async function downloadBundle(destination, signal) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]);
    const hash = createHash('sha256');
    let bytes = 0;
    const measure = new Transform({ transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > ARCHIVE.bytes) return callback(new Error('Crest model archive exceeds the expected size'));
        hash.update(chunk);
        callback(null, chunk);
    } });
    const response = await fetch(ARCHIVE.url, { signal: deadline, redirect: 'error' });
    if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`l2solo.com returned HTTP ${response.status} for ${ARCHIVE.name}`);
    }
    await pipeline(response.body, measure, fs.createWriteStream(destination, { flags: 'wx' }), { signal: deadline });
    if (bytes !== ARCHIVE.bytes || hash.digest('hex') !== ARCHIVE.sha256) {
        throw new Error(`Checksum mismatch for ${ARCHIVE.name}`);
    }
}

async function unpackBundle(archive, directory, signal) {
    const seen = new Set();
    await extractZip(archive, { dir: directory, onEntry(entry) {
        signal.throwIfAborted();
        const name = entry.fileName;
        const type = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (!CONTENTS.has(name) || seen.has(name) || (type !== 0 && type !== 0x8000)) {
            throw new Error('Unexpected entry in crest model archive');
        }
        seen.add(name);
    } });
    if (seen.size !== CONTENTS.size || !(await validModelFiles(directory, signal))) {
        throw new Error('Unpacked crest model failed verification');
    }
}

async function prepareModelFiles(directory, signal, onDownload) {
    if (await validModelFiles(directory, signal)) return;
    const parent = path.dirname(directory);
    await fs.promises.mkdir(parent, { recursive: true });
    const stage = await fs.promises.mkdtemp(path.join(parent, '.crest-model-'));
    try {
        const archive = path.join(stage, ARCHIVE.name);
        const unpacked = path.join(stage, 'model');
        onDownload(ARCHIVE.name);
        await downloadBundle(archive, signal);
        await unpackBundle(archive, unpacked, signal);
        signal.throwIfAborted();
        await fs.promises.mkdir(directory, { recursive: true });
        // Verified files have identical bytes across installers. Publish the manifest last.
        for (const name of CONTENTS) {
            const file = path.join(directory, name);
            try { await fs.promises.rename(path.join(unpacked, name), file); }
            catch (error) {
                if (await validModelFiles(directory, signal)) return;
                throw error;
            }
        }
    } finally {
        await fs.promises.rm(stage, { recursive: true, force: true });
    }
}

module.exports = { MODEL_VERSION, prepareModelFiles };
