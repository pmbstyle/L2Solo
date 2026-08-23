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
let classicPalette = null;

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

function classicC4Palette() {
    if (classicPalette) return classicPalette;

    // C4 crest uploads are limited to 256 bytes. A canonical 16x12 4-bit
    // BMP is 214 bytes (54-byte header + 16-color palette + 96 pixels).
    // This is the old Windows palette used by compact C4 crest files.
    const palette = Buffer.from(
        '0000000000008000008000000080800080000000800080008080000080808000'
        + 'c0c0c0000000ff0000ff000000ffff00ff000000ff00ff00ffff0000ffffff00',
        'hex'
    );
    classicPalette = palette;
    return palette;
}

function nearestClassicPaletteIndex(palette, sourceIndex) {
    const sourceOffset = sourceIndex * 4;
    const blue = palette[sourceOffset] || 0;
    const green = palette[sourceOffset + 1] || 0;
    const red = palette[sourceOffset + 2] || 0;
    const targetPalette = classicC4Palette();
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < 16; index += 1) {
        const offset = index * 4;
        const blueDelta = blue - targetPalette[offset];
        const greenDelta = green - targetPalette[offset + 1];
        const redDelta = red - targetPalette[offset + 2];
        const distance = (blueDelta * blueDelta) + (greenDelta * greenDelta)
            + (redDelta * redDelta);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    }

    return bestIndex;
}

function sourcePixelIndex(bytes, pixelOffset, rowStride, bitsPerPixel, row, column) {
    const rowOffset = pixelOffset + (row * rowStride);
    if (bitsPerPixel === 4) {
        const value = bytes[rowOffset + Math.floor(column / 2)] || 0;
        return column % 2 === 0 ? (value >> 4) & 0x0f : value & 0x0f;
    }
    return bytes[rowOffset + column] || 0;
}

function clientCrestData(data, kind = 'clan') {
    const bytes = Buffer.from(data || []);
    if (bytes.length < 54 || bytes.toString('ascii', 0, 2) !== 'BM') return bytes;

    const expected = EXPECTED[kind] || EXPECTED.clan;
    const pixelOffset = bytes.readUInt32LE(10);
    const width = Math.abs(bytes.readInt32LE(18));
    const height = Math.abs(bytes.readInt32LE(22));
    const planes = bytes.readUInt16LE(26);
    const bitsPerPixel = bytes.readUInt16LE(28);
    const compression = bytes.readUInt32LE(30);
    const rowBytes = Math.ceil(width * bitsPerPixel / 8);
    const rowStride = Math.ceil(rowBytes / 4) * 4;
    const sourcePixelBytes = rowStride * height;

    if (width !== expected.width || height !== expected.height || planes !== 1
        || ![4, expected.bitsPerPixel].includes(bitsPerPixel) || compression !== 0
        || pixelOffset < 54 || pixelOffset + sourcePixelBytes > bytes.length) {
        return bytes;
    }

    // Convert modern 8-bit assets (or a legacy 4-bit row) to the compact C4
    // representation. The source palette can be sparse; the response uses a
    // fixed 16-color palette and remaps every source pixel to its nearest
    // classic color so the client receives a genuinely valid small BMP.
    const targetPixelOffset = 54 + (16 * 4);
    const targetRowBytes = Math.ceil(width * 4 / 8);
    const targetPixelBytes = targetRowBytes * height;
    const target = Buffer.alloc(targetPixelOffset + targetPixelBytes);
    bytes.copy(target, 0, 0, 54);
    target.writeUInt32LE(target.length, 2);
    target.writeUInt32LE(targetPixelOffset, 10);
    target.writeUInt16LE(4, 28);
    target.writeUInt32LE(targetPixelBytes, 34);
    target.writeInt32LE(0, 38);
    target.writeInt32LE(0, 42);
    target.writeUInt32LE(0, 46);
    target.writeUInt32LE(0, 50);

    const sourcePaletteBytes = Math.max(0, Math.min(pixelOffset - 54, 256 * 4));
    const sourcePalette = Buffer.alloc(256 * 4);
    bytes.copy(sourcePalette, 0, 54, 54 + sourcePaletteBytes);
    const targetPalette = classicC4Palette();
    targetPalette.copy(target, 54);
    for (let row = 0; row < height; row += 1) {
        for (let column = 0; column < width; column += 1) {
            const sourceIndex = sourcePixelIndex(
                bytes, pixelOffset, rowStride, bitsPerPixel, row, column
            );
            const targetIndex = nearestClassicPaletteIndex(sourcePalette, sourceIndex);
            const targetOffset = targetPixelOffset + (row * targetRowBytes) + Math.floor(column / 2);
            if (column % 2 === 0) target[targetOffset] = targetIndex << 4;
            else target[targetOffset] |= targetIndex;
        }
    }
    return target;
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
        classicPalette = null;
    }
};

module.exports = ClanCrestService;
