'use strict';

// Value object: one fighter's numbers for one hit, as a hit's rules read
// them (HitRules). Two adapters build it: the hot Attack from a live actor
// (its effects, gear, position), the cold fight from its light profile.
// Frozen; compared by content; nothing in it knows where it came from.
//
// As the attacker: pAtk, pAtkRnd (weapon spread), mAtk, critRate (per mille,
// position applied), critDamageMul, critDamageAdd, mCritRate (per mille),
// str (effective, for a physical skill's critical). As the defender: pDef,
// mDef, shieldPDef, shieldRate (percent), dex.
const DEFAULTS = Object.freeze({ pAtk: 0, pAtkRnd: 0, mAtk: 0, critRate: 0, critDamageMul: 1, critDamageAdd: 0, mCritRate: 0,
    str: 1, pDef: 1, mDef: 1, shieldPDef: 0, shieldRate: 0, dex: 0 });

function view(fields = {}) {
    const out = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
        const value = Number(fields[key]);
        if (Number.isFinite(value)) out[key] = value;
    }
    return Object.freeze(out);
}

module.exports = { view, DEFAULTS };
