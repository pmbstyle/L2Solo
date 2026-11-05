'use strict';

// The native rest owner supplies the calculation. This startup projection
// preserves levels 1..80, numeric class keys and the last duplicate class row.
// Each class tree profile is built for its tick and dropped (the rest's own
// held profile and its regen terms for every class x level kept ~14 MB per
// thread): only the rates outlive the sweep.
function seatedMpRates(classRows, Rest, ratesByClass = new Map()) {
    for (const row of classRows || []) {
        const rates = new Float64Array(81), classId = Number(row.classId);
        for (let level = 1; level <= 80; level++) rates[level] = Rest.coldRestRegenPerTick({ level,
            stats: { classId } }, { profile: Rest.treeProfile(classId, level) }).mp * 1200;
        ratesByClass.set(Number(row.classId), rates);
    }
    return ratesByClass;
}
module.exports = { seatedMpRates };
