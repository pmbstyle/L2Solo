const fs = require('fs');
const path = require('path');

const Database = invoke('Database');

const CREST_ROOT = path.resolve(process.cwd(), 'data', 'crests');
const MANIFEST_FILE = path.join(CREST_ROOT, 'manifest.json');
const EXPECTED = {
    clan: { width: 16, height: 12, bitsPerPixel: 8 },
    ally: { width: 8, height: 12, bitsPerPixel: 8 }
};

let library = null;

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function readBmp(entry, kind) {
    const expected = EXPECTED[kind];
    const file = path.resolve(process.cwd(), String(entry.file || ''));
    if (!file.startsWith(`${CREST_ROOT}${path.sep}`)) throw new Error(`crest path escapes asset root: ${entry.file}`);
    const data = fs.readFileSync(file);
    if (data.length < 54 || data.toString('ascii', 0, 2) !== 'BM') throw new Error(`invalid BMP: ${entry.file}`);
    const width = Math.abs(data.readInt32LE(18));
    const height = Math.abs(data.readInt32LE(22));
    const bitsPerPixel = data.readUInt16LE(28);
    if (width !== expected.width || height !== expected.height || bitsPerPixel !== expected.bitsPerPixel) {
        throw new Error(`unexpected ${kind} BMP geometry: ${entry.file}`);
    }
    return {
        id: number(entry.id),
        file: String(entry.file),
        source: String(entry.source || ''),
        width,
        height,
        bitsPerPixel,
        data
    };
}

function clientCrestData(data, kind = 'clan') {
    const bytes = Buffer.from(data || []);
    if (bytes.length < 54 || bytes.toString('ascii', 0, 2) !== 'BM') return bytes;

    const expected = EXPECTED[kind] || EXPECTED.clan;
    const pixelOffset = bytes.readUInt32LE(10);
    const width = Math.abs(bytes.readInt32LE(18));
    const height = Math.abs(bytes.readInt32LE(22));
    const bitsPerPixel = bytes.readUInt16LE(28);
    const compression = bytes.readUInt32LE(30);
    const rowBytes = Math.ceil(width * bitsPerPixel / 8);
    const rowStride = Math.ceil(rowBytes / 4) * 4;

    if (width !== expected.width || height !== expected.height || bitsPerPixel !== expected.bitsPerPixel
        || compression !== 0 || pixelOffset + rowStride * height > bytes.length) {
        return bytes;
    }

    // C4's RequestSetPledgeCrest accepts the indexed pixel payload (16x12
    // bytes for a clan crest), not the BMP header/palette. Normalize both the
    // imported BMP assets and legacy database rows before PledgeCrest sends it.
    const payload = Buffer.alloc(rowBytes * height);
    const sourceHeight = bytes.readInt32LE(22);
    for (let row = 0; row < height; row += 1) {
        const sourceRow = sourceHeight > 0 ? height - 1 - row : row;
        bytes.copy(payload, row * rowBytes, pixelOffset + sourceRow * rowStride,
            pixelOffset + sourceRow * rowStride + rowBytes);
    }
    return payload;
}

function loadLibrary() {
    if (library) return library;
    if (!fs.existsSync(MANIFEST_FILE)) {
        library = { clan: [], ally: [] };
        return library;
    }
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    library = { clan: [], ally: [] };
    Object.keys(EXPECTED).forEach((kind) => {
        (Array.isArray(manifest[kind]) ? manifest[kind] : []).forEach((entry) => {
            try {
                library[kind].push(readBmp(entry, kind));
            } catch (error) {
                utils.infoWarn('ClanCrest', 'skipping %s: %s', entry.file, error.message);
            }
        });
    });
    return library;
}

function assetFor(kind, clanId, usedIds = new Set()) {
    const assets = loadLibrary()[kind] || [];
    if (!assets.length) return null;
    const seed = Math.abs((number(clanId) * 2654435761) >>> 0);
    for (let offset = 0; offset < assets.length; offset += 1) {
        const candidate = assets[(seed + offset) % assets.length];
        if (!usedIds.has(candidate.data.toString('hex'))) return candidate;
    }
    return assets[seed % assets.length];
}

async function ensureAutonomousCrest(clanId) {
    const rows = await Database.fetchAutonomousClanCrests();
    const target = rows.find((row) => number(row.id) === number(clanId));
    if (!target) return { ok: false, code: 'not_autonomous' };
    if (number(target.level) < 3) {
        if (number(target.crestId) > 0) return Database.clearAutonomousClanCrest({ clanId, kind: 'pledge' });
        return { ok: true, skipped: true, code: 'level_too_low' };
    }
    if (number(target.crestId) > 0) return { ok: true, idempotent: true, crestId: number(target.crestId) };
    const usedKeys = new Set(rows.map((row) => Buffer.from(row.crestData || []).toString('hex')).filter(Boolean));
    const asset = assetFor('clan', clanId, usedKeys);
    if (!asset) return { ok: false, code: 'crest_assets_unavailable' };
    const result = await Database.assignAutonomousClanCrest({ clanId, data: asset.data });
    return { ...result, assetId: asset.id, assetFile: asset.file };
}

async function ensureAutonomousClans() {
    const rows = await Database.fetchAutonomousClanCrests();
    const usedKeys = new Set(rows.map((row) => Buffer.from(row.crestData || []).toString('hex')).filter(Boolean));
    const results = [];
    let cleared = 0;
    for (const row of rows) {
        if (number(row.level) < 3) {
            if (number(row.crestId) > 0) {
                const result = await Database.clearAutonomousClanCrest({ clanId: row.id, kind: 'pledge' });
                if (result.ok && result.cleared) cleared += 1;
            }
            continue;
        }
        if (number(row.crestId) > 0) continue;
        const asset = assetFor('clan', row.id, usedKeys);
        if (!asset) break;
        const result = await Database.assignAutonomousClanCrest({ clanId: row.id, data: asset.data });
        if (result.ok) {
            usedKeys.add(asset.data.toString('hex'));
            results.push({ ...result, assetId: asset.id, assetFile: asset.file });
        }
    }
    if (results.length || cleared) utils.infoSuccess('ClanCrest', 'assigned %d and cleared %d autonomous clan crests', results.length, cleared);
    return { ok: true, assigned: results.length, cleared, results };
}

const ClanCrestService = {
    assets(kind = 'clan') {
        return [...(loadLibrary()[kind] || [])].map(({ data, ...asset }) => asset);
    },
    clientCrestData,
    assetFor,
    ensureAutonomousCrest,
    ensureAutonomousClans,
    reset() {
        library = null;
    }
};

module.exports = ClanCrestService;
