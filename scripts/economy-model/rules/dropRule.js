'use strict';

// The drop rule of the economy design: what one kill yields of each item of a
// reward group, at the rates of its kind (adena, drop, spoil, raid, epic). Pure: the
// group and the rates arrive as plain data, the deep-blue penalty as the
// caller's ProgressionRates.deepBlueRule answer. Read by the economy model's
// income and engine; the server's drop owner takes it over unchanged.
//
// A rate scales the expected yield of every item exactly once (ours, reading
// of the design: a rate that multiplied both rolls and amounts would square
// it). It multiplies the group's successful rolls: a chance above 100 %
// becomes extra rolls, as Lisvus does. The excess counts for every NPC at
// every rate, x1 included: a raid boss group listed at 149 % rolls 1.49
// times a kill (today's ProgressionRates keeps one roll at x1, the game's
// difference from the rule). Each roll picks one item
// by the group's own weights, which stay x1 (today's capped weights make a
// 0.14 % recipe 4.8 % at x50). In an adena group the extra rolls are the
// adena amount multiplied, as Lisvus multiplies the amount above 100 %: equal
// in expectation. A spoil row is rated on its own, every row of a group
// independent (Lisvus L2Attackable.calculateRewardItem).

// The design's rates per kind and preset (popular servers' rates, our choice
// of the numbers); adena follows the exp rate (x10: 10, x50: 50) so a level
// brings the money it brings at x1, as established servers run it (our choice,
// maintainer decision 126); NPC prices stay x1 at every preset. raid and epic rate the
// item drops of a raid boss and of an epic boss (adena stays at the adena
// rate, spoil at the spoil rate); the caller tells an NPC's kind (npcKind).
const DESIGN_RATES = Object.freeze({
    x1: Object.freeze({ adena: 1, drop: 1, spoil: 1, raid: 1, epic: 1 }),
    x10: Object.freeze({ adena: 10, drop: 4, spoil: 4, raid: 3, epic: 1 }),
    x50: Object.freeze({ adena: 50, drop: 15, spoil: 10, raid: 5, epic: 1 })
});

// The epic bosses of C4 (Lisvus L2GrandBossInstance spawns: Queen Ant, Core,
// Orfen, Antharas; Baium, Zaken and Valakas are not in our NPC data).
const EPIC_IDS = Object.freeze(new Set([12001, 12052, 12169, 12211]));

// An NPC's rate kind from its record { selfId, template: { kind } }: 'epic'
// for an epic boss, 'raid' for any other NPC whose kind is Boss (raid bosses
// and the Boss-kind guards of the epics), else 'normal'.
function npcKind(npc) {
    if (EPIC_IDS.has(Number(npc?.selfId))) return 'epic';
    return String(npc?.template?.kind || '').toLowerCase() === 'boss' ? 'raid' : 'normal';
}

const ADENA = 57;
const NO_PENALTY = Object.freeze({ active: false, chanceMultiplier: 1, minimumChance: 0 });

function positive(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function meanAmount(item) {
    const min = Math.max(1, Math.floor(positive(item.min) || 1));
    return (min + Math.max(min, Math.floor(positive(item.max) || min))) / 2;
}

// The rate a group rolls at: adena groups at the adena rate, spoil at the
// spoil rate, the other drops at the drop rate or the NPC kind's (raid,
// epic). Under the deep-blue penalty adena is divided by the drop rate
// first, as Lisvus does (ProgressionRates.rewardGroupRoll).
function groupRate(group, kind, rates, penalty, of) {
    const adena = (group.items || []).some(item => Number(item.selfId) === ADENA);
    const itemRate = kind === 'spoil' ? rates.spoil : of === 'normal' ? rates.drop : rates[of];
    let rate = adena ? positive(rates.adena) : positive(itemRate);
    if (penalty.active) {
        rate *= positive(penalty.chanceMultiplier);
        if (adena) rate = positive(rates.drop) > 0 ? rate / positive(rates.drop) : 0;
    }
    return rate;
}

// Expected items per kill from one group: { itemId: count }.
// group { overall, items: [{ selfId, chance, min, max }] } (chances in %);
// kind 'drop' | 'spoil'; rates { adena, drop, spoil, raid, epic }; of: the
// NPC's npcKind ('normal' | 'raid' | 'epic'); penalty: deepBlueRule's
// { active, chanceMultiplier, minimumChance } (minimumChance in %).
function dropRule({ group, kind = 'drop', rates, of = 'normal', penalty = NO_PENALTY }) {
    if (!['normal', 'raid', 'epic'].includes(of)) throw new Error(`unknown NPC kind ${of}`);
    const out = {}, items = group?.items || [];
    const rate = groupRate(group || {}, kind, rates, penalty || NO_PENALTY, of);
    const floorChance = penalty?.active ? positive(penalty.minimumChance) : 0;
    if (!(rate > 0) || !items.length) return out;
    const overall = positive(group.overall);
    if (kind === 'spoil') {
        for (const item of items) {
            const base = overall * positive(item.chance) / 100;
            if (!(base > 0)) continue;
            const rolls = Math.max(floorChance, base * rate) / 100;
            out[item.selfId] = (out[item.selfId] || 0) + rolls * meanAmount(item);
        }
        return out;
    }
    if (!(overall > 0)) return out;
    const weightSum = items.reduce((sum, item) => sum + positive(item.chance), 0);
    if (!(weightSum > 0)) return out;
    const rolls = Math.max(floorChance, overall * rate) / 100;
    for (const item of items) {
        const pick = positive(item.chance) / weightSum;
        if (pick > 0) out[item.selfId] = (out[item.selfId] || 0) + rolls * pick * meanAmount(item);
    }
    return out;
}

module.exports = { dropRule, npcKind, DESIGN_RATES };
