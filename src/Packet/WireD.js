const MAX_UNSIGNED_D = 0xffffffff;

function numericValue(value) {
    return typeof value === 'bigint' ? Number(value) : Number(value);
}

function isRepresentable(value) {
    const number = numericValue(value);
    return Number.isSafeInteger(number) && number >= 0 && number <= MAX_UNSIGNED_D;
}

function bounded(value) {
    const number = numericValue(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(MAX_UNSIGNED_D, Math.floor(number)));
}

module.exports = {
    MAX_UNSIGNED_D,
    isRepresentable,
    bounded
};
