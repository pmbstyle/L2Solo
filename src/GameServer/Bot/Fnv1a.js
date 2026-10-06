'use strict';
// Shared 32-bit input digest; derived caches keep it in memory, never in saves.
function fnv1a32(text, seed = 0x811c9dc5) {
    let hash = seed >>> 0;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
    return hash;
}
module.exports = { fnv1a32 };
