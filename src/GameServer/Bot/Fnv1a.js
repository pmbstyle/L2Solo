'use strict';
// Shared 32-bit input digest; derived caches keep it in memory, never in saves.
function fnv1a32(text, seed = 0x811c9dc5) {
    let hash = seed >>> 0;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
    return hash;
}
// A held answer's key from its input text: two FNV-1a passes (seeds
// 0x811c9dc5 and 0x01000193) in one loop and the length, ~20 characters.
function textDigest(text) {
    let a = 0x811c9dc5, b = 0x01000193;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        a = Math.imul(a ^ code, 0x01000193) >>> 0; b = Math.imul(b ^ code, 0x01000193) >>> 0;
    }
    return `${a}.${b}.${text.length}`;
}
module.exports = { fnv1a32, textDigest };
