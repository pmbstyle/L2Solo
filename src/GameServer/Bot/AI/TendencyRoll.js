// One roll by tendency (shared by hot and cold). A character's tendency is a
// chance, never 0 or 1: an uncharacteristic act stays rare but possible. One
// decision gets one deterministic roll from the decision's key parts, with no
// stored state, so a repeated or re-checked decision reads the same roll.
const MIN = 0.02;
const MAX = 0.98;
const FNV_OFFSET = 2166136261;

function chance(p) {
    return Math.max(MIN, Math.min(MAX, Number(p) || 0));
}

// FNV-1a over the first UTF-16 unit of each code point of the text, as a
// for-of over the text reads it. The index loop gives the same hash without
// an iterator and a one-character string per character.
function hashText(h, text) {
    for (let i = 0; i < text.length; i++) {
        const unit = text.charCodeAt(i);
        h = Math.imul(h ^ unit, 16777619);
        if (unit >= 0xD800 && unit <= 0xDBFF && i + 1 < text.length) {
            const next = text.charCodeAt(i + 1);
            if (next >= 0xDC00 && next <= 0xDFFF) i++;
        }
    }
    return h;
}

function mulberry(h) {
    let t = Math.imul(h ^ h >>> 15, 1 | h); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296;
}

// A seeded stream (FNV-1a over the seed text, then a mulberry32 step).
function seeded(seed) {
    let h = FNV_OFFSET;
    if (typeof seed === 'string') h = hashText(h, seed);
    else for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return () => { h += 0x6D2B79F5; return mulberry(h); };
}

// One roll in [0, 1) for one decision: the first value of the stream seeded
// with the parts joined by ':'. Hashed part by part (a ':' between parts
// never completes a surrogate pair), so no joined text is built.
function roll(...parts) {
    let h = FNV_OFFSET;
    for (let i = 0; i < parts.length; i++) {
        if (i) h = Math.imul(h ^ 0x3A, 16777619);
        const part = parts[i];
        // As Array.prototype.join: null and undefined are empty, others ToString.
        if (part !== undefined && part !== null) h = hashText(h, typeof part === 'string' ? part : `${part}`);
    }
    return mulberry(h + 0x6D2B79F5);
}

module.exports = { MIN, MAX, chance, seeded, roll };
