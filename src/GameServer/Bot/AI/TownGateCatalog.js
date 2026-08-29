// Physical town passages extracted offline from successful C4 geodata routes.
// Each gate keeps a point on both sides of the town boundary plus the narrow
// passage itself. Runtime routing only scores this static list; it never scans
// geodata or runs extra pathfinding to discover a gate.

function point(locX, locY, locZ) {
    return Object.freeze({ locX, locY, locZ });
}

function gate(id, inside, passage, outside) {
    return Object.freeze({ id, inside: point(...inside), passage: point(...passage), outside: point(...outside) });
}

const GATES = Object.freeze({
    'Talking Island': Object.freeze([
        gate('east', [-82647, 244713, -3728], [-82455, 244722, -3728], [-82263, 244731, -3728]),
        gate('west', [-86082, 244424, -3728], [-86274, 244435, -3720], [-86466, 244446, -3720]),
        gate('southwest', [-86188, 241432, -3728], [-86184, 241240, -3728], [-86180, 241048, -3728]),
        gate('southeast', [-82530, 241526, -3728], [-82513, 241335, -3728], [-82496, 241144, -3728])
    ]),
    Gludin: Object.freeze([
        gate('east', [-78968, 152600, -3168], [-78776, 152600, -3168], [-78584, 152600, -3160]),
        gate('northeast', [-78102, 156132, -3176], [-77982, 156282, -3184], [-77862, 156432, -3192]),
        gate('southwest', [-82879, 149537, -3120], [-82935, 149353, -3112], [-82991, 149169, -3112])
    ]),
    Gludio: Object.freeze([
        gate('east', [-12184, 123421, -3096], [-12024, 123528, -3088], [-11864, 123635, -3080]),
        gate('north', [-14184, 126279, -3136], [-14185, 126471, -3144], [-14186, 126663, -3152]),
        gate('west', [-16349, 124284, -3112], [-16538, 124317, -3120], [-16727, 124350, -3112]),
        gate('southwest', [-14524, 121244, -2984], [-14647, 121097, -2992], [-14770, 120950, -2984])
    ]),
    Dion: Object.freeze([
        gate('east', [21225, 145895, -3144], [21417, 145906, -3144], [21609, 145917, -3160]),
        gate('northwest', [15693, 144324, -3048], [15702, 144516, -3072], [15711, 144708, -3080]),
        gate('west-inner', [15507, 143514, -2744], [15471, 143703, -2776], [15435, 143892, -2824]),
        gate('south', [15359, 142283, -2688], [15292, 142103, -2688], [15225, 141923, -2688])
    ]),
    Giran: Object.freeze([
        gate('northwest', [81599, 152634, -3528], [81599, 152826, -3528], [81599, 153018, -3528]),
        gate('west', [77336, 148724, -3592], [77144, 148714, -3592], [76952, 148704, -3600]),
        gate('southwest', [81505, 143815, -3528], [81500, 143623, -3528], [81495, 143431, -3528]),
        gate('south', [83735, 141683, -3528], [83730, 141491, -3528], [83725, 141299, -3520]),
        gate('east', [90248, 147214, -3528], [90440, 147209, -3528], [90632, 147204, -3528])
    ]),
    Oren: Object.freeze([
        gate('south', [81137, 53239, -1552], [81120, 53048, -1560], [81103, 52857, -1584]),
        gate('north', [81678, 56062, -1520], [81621, 56245, -1520], [81564, 56428, -1544]),
        gate('west', [79810, 54169, -1552], [79632, 54240, -1560], [79454, 54311, -1584])
    ])
});

function distance(first, second) {
    return Math.hypot(
        Number(first?.locX || 0) - Number(second?.locX || 0),
        Number(first?.locY || 0) - Number(second?.locY || 0)
    );
}

function gatesFor(townName) {
    return GATES[String(townName || '').trim()] || [];
}

function isGatePoint(loc) {
    if (!loc) return false;
    return Object.values(GATES).some((gates) => gates.some((candidate) => (
        ['inside', 'passage', 'outside'].some((side) => (
            candidate[side].locX === loc.locX
            && candidate[side].locY === loc.locY
            && candidate[side].locZ === loc.locZ
        ))
    )));
}

function best(townName, from, to, entering = false) {
    let selected = null;
    let bestScore = Infinity;
    for (const candidate of gatesFor(townName)) {
        const nearSide = entering ? candidate.outside : candidate.inside;
        const farSide = entering ? candidate.inside : candidate.outside;
        const score = distance(from, nearSide) + distance(to, farSide);
        if (score < bestScore) {
            selected = candidate;
            bestScore = score;
        }
    }
    return selected;
}

module.exports = {
    GATES,
    bestEntry(townName, from, to) {
        return best(townName, from, to, true);
    },
    bestExit(townName, from, to) {
        return best(townName, from, to, false);
    },
    gatesFor,
    isGatePoint
};
