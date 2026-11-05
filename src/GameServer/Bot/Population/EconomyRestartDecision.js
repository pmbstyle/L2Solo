'use strict';

// The existing stats update carries one bounded decision, never its graph.
// The economy owner validates the saved proof.
const FailureLog = require('../../../FailureLog');
const { deflateRawSync, inflateRawSync } = require('node:zlib');
const MAX_BYTES = 1024, MAX_PLAIN_BYTES = 16384;
// 5: the metadata row without the card key (the card carries its echo, the
// row's decisionSeq, activityLeaf and focus); the restart prefix inside is
// format 4. 6: the same format; the decisions it holds start on the woken
// store (Situations) and a decisionSeq raises no longer move, so every bot
// builds once. An older card is refused before inflate: one rebuild per bot.
const VERSION = 6;

function cardData(value, maxBytes) {
    if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
    const bytes = Buffer.from(value, 'base64');
    return bytes.byteLength >= 28 && bytes.byteLength <= maxBytes && bytes.toString('base64') === value
        ? Uint8Array.from(bytes).buffer : null;
}

function encode(accepted, baselineIdentity) {
    if (!(accepted?.eventProof instanceof Uint8Array) || !(accepted.card?.data instanceof ArrayBuffer)
        || typeof baselineIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(baselineIdentity)) return null;
    try {
        const metadata = Buffer.from(JSON.stringify([accepted.decisionSeq, accepted.activityLeaf,
            accepted.focus, accepted.activity, accepted.mp, accepted.characterId]));
        const card = Buffer.from(accepted.card.data), proof = Buffer.from(accepted.eventProof);
        const size = 36 + metadata.length + card.length + proof.length;
        if (!proof.length || metadata.length > 65535 || card.length > 65535 || size > MAX_PLAIN_BYTES) return null;
        const plain = Buffer.allocUnsafe(size);
        plain.writeUInt16LE(metadata.length, 0); plain.writeUInt16LE(card.length, 2);
        Buffer.from(baselineIdentity, 'hex').copy(plain, 4);
        metadata.copy(plain, 36); card.copy(plain, 36 + metadata.length); proof.copy(plain, 36 + metadata.length + card.length);
        const value = [VERSION, deflateRawSync(plain, { level: 6 }).toString('base64')];
        return Buffer.byteLength(JSON.stringify({ wishAdvisory: value })) <= MAX_BYTES ? value : null;
    } catch (error) { FailureLog.note('economy.codec:advisory_encode', error); return null; }
}

function decode(value, timestamp, maxCardBytes, characterId, baseline, baselineIdentity) {
    if (!Array.isArray(value) || value.length !== 2 || value[0] !== VERSION
        || typeof value[1] !== 'string' || value[1].length > MAX_BYTES
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(value[1])
        || typeof baselineIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(baselineIdentity)) return null;
    try {
        if (Buffer.byteLength(JSON.stringify({ wishAdvisory: value })) > MAX_BYTES) return null;
        const compressed = Buffer.from(value[1], 'base64');
        if (compressed.toString('base64') !== value[1]) return null;
        const plain = inflateRawSync(compressed, { maxOutputLength: MAX_PLAIN_BYTES });
        if (plain.length < 36 || plain.subarray(4, 36).toString('hex') !== baselineIdentity) return null;
        const metadataSize = plain.readUInt16LE(0), cardSize = plain.readUInt16LE(2), cardAt = 36 + metadataSize;
        if (cardSize < 28 || cardSize > maxCardBytes || cardAt + cardSize >= plain.length) return null;
        const raw = plain.subarray(36, cardAt), text = raw.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(raw)) return null;
        const row = JSON.parse(text);
        if (!Array.isArray(row) || row.length !== 6
            || !Number.isSafeInteger(row[0]) || row[0] < 0
            || !Number.isSafeInteger(row[1]) || row[1] < 0 || row[1] > 0xffffffff
            || row[2] !== null && (typeof row[2] !== 'string' || row[2].length > 128)
            || typeof row[3] !== 'string' || !Number.isFinite(row[4])
            || !Number.isSafeInteger(row[5]) || row[5] <= 0 || row[5] !== characterId) return null;
        const at = baseline?.at;
        if (!Number.isFinite(at) || !Number.isFinite(timestamp) || timestamp < at) return null;
        const data = Uint8Array.from(plain.subarray(cardAt, cardAt + cardSize)).buffer;
        return { data, decisionSeq: row[0], activityLeaf: row[1], focus: row[2], baseline,
            activity: row[3], mp: row[4], eventProof: Uint8Array.from(plain.subarray(cardAt + cardSize)),
            characterId: row[5], saved: value };
    } catch (error) {
        // A saved card that inflates past the cap is refused like the checks above; anything else is a bug.
        if (error?.code !== 'ERR_BUFFER_TOO_LARGE') FailureLog.note('economy.codec:advisory_decode', error);
        return null;
    }
}

module.exports = { encode, decode, cardData, MAX_BYTES };
