// Generated population names intentionally come from a local, original corpus.
// It captures the short fantasy and player-style nicknames common in MMORPGs
// without distributing or impersonating names taken from player accounts.
const STARTS = [
    'Ael', 'Aer', 'Ari', 'Ash', 'Astra', 'Bren', 'Cael', 'Cind', 'Cor', 'Dae',
    'Dra', 'Eli', 'Ery', 'Fen', 'Galen', 'Iri', 'Kael', 'Kira', 'Lio', 'Lun',
    'Mira', 'Ner', 'Nyx', 'Ori', 'Rae', 'Rav', 'Sera', 'Syl', 'Tae', 'Thorn',
    'Vale', 'Vex', 'Wyn', 'Xan', 'Yara', 'Zer'
];

const ENDS = [
    'a', 'ae', 'an', 'ar', 'ara', 'as', 'el', 'en', 'er', 'eth', 'ia', 'ian',
    'iel', 'in', 'ira', 'is', 'on', 'or', 'os', 'ra', 'ren', 'ric', 'ris', 'ros',
    'yn', 'ys'
];

const MIDDLES = [
    'a', 'ae', 'an', 'ar', 'ava', 'dra', 'el', 'en', 'eth', 'ia', 'iel', 'in',
    'ira', 'ka', 'or', 'ra', 'ren', 'ri', 'ryn', 'sa', 'sha', 'th', 'va', 'ver', 'wyn'
];

function mix(value) {
    let hash = Number(value) >>> 0;
    hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
    hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
    return (hash ^ (hash >>> 16)) >>> 0;
}

function normalize(name) {
    return name.slice(0, 16);
}

function alphabeticToken(seed, length = 3) {
    const modulus = 26 ** length;
    // This is a permutation of the alphabetic token space, so nearby
    // population slots do not collide while generated names remain digit-free.
    let value = Number((BigInt(Math.trunc(seed)) * 7919n) % BigInt(modulus));
    let token = '';
    for (let index = 0; index < length; index++) {
        token += String.fromCharCode(97 + (value % 26));
        value = Math.floor(value / 26);
    }
    return token;
}

function nameFor(index) {
    const seed = Math.max(0, Number(index) || 0);
    const slot = mix(seed);
    const nameSlot = slot;
    const start = STARTS[nameSlot % STARTS.length];
    const end = ENDS[Math.floor(nameSlot / STARTS.length) % ENDS.length];
    const middle = MIDDLES[Math.floor(nameSlot / (STARTS.length * ENDS.length)) % MIDDLES.length];
    return normalize(`${start}${middle}${end}${alphabeticToken(seed)}`);
}

module.exports = { nameFor };
