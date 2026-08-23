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

function clientCrestData(data) {
    // C4 PledgeCrest returns the saved crest file verbatim. In particular,
    // preserve the 8-bit BMP header and palette; converting it to a compact
    // 4-bit BMP makes the legacy client repeatedly request and eventually
    // fail while decoding the same crest.
    return Buffer.from(data || []);
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
        return [...(loadLibrary()[kind] || [])].map((asset) => {
            const publicAsset = { ...asset };
            delete publicAsset.data;
            return publicAsset;
        });
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
