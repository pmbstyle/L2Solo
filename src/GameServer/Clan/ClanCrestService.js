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

function rgb565(color) {
    return ((color.r >> 3) << 11) | ((color.g >> 2) << 5) | (color.b >> 3);
}

function color565(value) {
    const r = (value >> 11) & 0x1f;
    const g = (value >> 5) & 0x3f;
    const b = value & 0x1f;
    return {
        r: (r << 3) | (r >> 2),
        g: (g << 2) | (g >> 4),
        b: (b << 3) | (b >> 2)
    };
}

function colorDistance(left, right) {
    const red = left.r - right.r;
    const green = left.g - right.g;
    const blue = left.b - right.b;
    return (red * red) + (green * green) + (blue * blue);
}

function dxtPalette(first, second) {
    const color0 = color565(first);
    const color1 = color565(second);
    return [
        color0,
        color1,
        {
            r: Math.round(((2 * color0.r) + color1.r) / 3),
            g: Math.round(((2 * color0.g) + color1.g) / 3),
            b: Math.round(((2 * color0.b) + color1.b) / 3)
        },
        {
            r: Math.round((color0.r + (2 * color1.r)) / 3),
            g: Math.round((color0.g + (2 * color1.g)) / 3),
            b: Math.round((color0.b + (2 * color1.b)) / 3)
        }
    ];
}

function encodeDxt1Block(colors, target, offset) {
    const quantized = colors.map((color) => color565(rgb565(color)));
    let firstIndex = 0;
    let secondIndex = 0;
    let greatestDistance = -1;
    for (let left = 0; left < quantized.length; left += 1) {
        for (let right = left + 1; right < quantized.length; right += 1) {
            const distance = colorDistance(quantized[left], quantized[right]);
            if (distance > greatestDistance) {
                greatestDistance = distance;
                firstIndex = left;
                secondIndex = right;
            }
        }
    }

    let first = rgb565(quantized[firstIndex]);
    let second = rgb565(quantized[secondIndex]);
    if (first < second) [first, second] = [second, first];
    const palette = dxtPalette(first, second);
    let indices = 0;
    colors.forEach((color, index) => {
        let selected = 0;
        let nearest = Number.POSITIVE_INFINITY;
        palette.forEach((candidate, candidateIndex) => {
            const distance = colorDistance(color, candidate);
            if (distance < nearest) {
                nearest = distance;
                selected = candidateIndex;
            }
        });
        indices |= selected << (index * 2);
    });

    target.writeUInt16LE(first, offset);
    target.writeUInt16LE(second, offset + 2);
    target.writeUInt32LE(indices >>> 0, offset + 4);
}

function dxt1Header(width, height) {
    const header = Buffer.alloc(128);
    header.write('DDS ', 0, 'ascii');
    header.writeUInt32LE(124, 4);
    header.writeUInt32LE(0x0a1007, 8);
    header.writeUInt32LE(height, 12);
    header.writeUInt32LE(width, 16);
    header.writeUInt32LE((width * height) / 2, 20);
    header.writeUInt32LE(32, 76);
    header.writeUInt32LE(4, 80);
    header.write('DXT1', 84, 'ascii');
    header.writeUInt32LE(0x1000, 108);
    return header;
}

function nextPowerOfTwo(value) {
    let result = 1;
    while (result < value) result *= 2;
    return result;
}

function bmpToDxt1Dds(data) {
    const source = Buffer.from(data || []);
    if (source.length < 54 || source.toString('ascii', 0, 2) !== 'BM') return source;

    const dibSize = source.readUInt32LE(14);
    const pixelOffset = source.readUInt32LE(10);
    const width = source.readInt32LE(18);
    const signedHeight = source.readInt32LE(22);
    const height = Math.abs(signedHeight);
    const bitsPerPixel = source.readUInt16LE(28);
    const compression = source.readUInt32LE(30);
    const paletteOffset = 14 + dibSize;
    const rowStride = Math.ceil(width / 4) * 4;
    const textureWidth = nextPowerOfTwo(width);
    const textureHeight = nextPowerOfTwo(height);
    if (dibSize !== 40 || width <= 0 || height <= 0 || width % 4 !== 0 || height % 4 !== 0) return source;
    if (bitsPerPixel !== 8 || compression !== 0 || pixelOffset < paletteOffset || pixelOffset > source.length) return source;
    if (source.length < pixelOffset + (rowStride * height)) return source;

    const result = Buffer.alloc(128 + ((textureWidth * textureHeight) / 2));
    dxt1Header(textureWidth, textureHeight).copy(result);
    let outputOffset = 128;
    for (let blockY = 0; blockY < textureHeight; blockY += 4) {
        for (let blockX = 0; blockX < textureWidth; blockX += 4) {
            const colors = [];
            for (let y = 0; y < 4; y += 1) {
                const imageY = blockY + y;
                for (let x = 0; x < 4; x += 1) {
                    const imageX = blockX + x;
                    if (imageX >= width || imageY >= height) {
                        colors.push({ r: 0, g: 0, b: 0 });
                        continue;
                    }
                    const sourceY = signedHeight > 0 ? (height - 1 - imageY) : imageY;
                    const paletteIndex = source[pixelOffset + (sourceY * rowStride) + blockX + x];
                    const colorOffset = paletteOffset + (paletteIndex * 4);
                    colors.push(colorOffset + 2 < pixelOffset ? {
                        r: source[colorOffset + 2],
                        g: source[colorOffset + 1],
                        b: source[colorOffset]
                    } : { r: 0, g: 0, b: 0 });
                }
            }
            encodeDxt1Block(colors, result, outputOffset);
            outputOffset += 8;
        }
    }
    return result;
}

function clientCrestData(data) {
    // Player uploads are already DDS-formatted by the client and must stay
    // byte-exact. Autonomous crests originate as BMP assets, so encode them
    // to the same compact DXT1 DDS payload before PledgeCrest delivery.
    return bmpToDxt1Dds(data);
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
    bmpToDxt1Dds,
    clientCrestData,
    assetFor,
    ensureAutonomousCrest,
    ensureAutonomousClans,
    reset() {
        library = null;
    }
};

module.exports = ClanCrestService;
