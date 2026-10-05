// One roll by tendency (shared by hot and cold). A character's tendency is a
// chance, never 0 or 1: an uncharacteristic act stays rare but possible. One
// decision gets one deterministic roll from the decision's key parts, with no
// stored state, so a repeated or re-checked decision reads the same roll.
const MIN = 0.02;
const MAX = 0.98;

function chance(p) {
    return Math.max(MIN, Math.min(MAX, Number(p) || 0));
}

// A seeded stream (FNV-1a over the seed text, then a mulberry32 step).
function seeded(seed) {
    let h = 2166136261;
    for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return () => { h += 0x6D2B79F5; let t = Math.imul(h ^ h >>> 15, 1 | h); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// One roll in [0, 1) for one decision.
function roll(...parts) {
    return seeded(parts.join(':'))();
}

module.exports = { MIN, MAX, chance, seeded, roll };
