'use strict';

const LastOperations = require('./LastOperations');
const SavedSkills = require('./SavedSkills');
function significant(value) { return Number.isFinite(value) ? Number(value.toPrecision(3)) : value; }
function compact(stats = {}) {
    const next = { ...stats };
    if (next.equipmentPlan) {
        next.equipmentPlan = { ...next.equipmentPlan };
        delete next.equipmentPlan.economyInputKey; delete next.equipmentPlan.inputKey;
    }
    delete next.marketTrades; delete next.priceBeliefs;
    if (next.coldCombat) next.coldCombat = SavedSkills.packKit(next.coldCombat);
    // ARCH-NOTE: existing worlds retain old operation lists (91 withdrawals,
    // 57 NPC sales in the saved-current fixture). Bound them on an ordinary
    // save too, so bots need no new withdrawal/liquidation or startup pass.
    if (next.lastWarehouseWithdrawal) next.lastWarehouseWithdrawal = LastOperations.normalize(next.lastWarehouseWithdrawal);
    if (next.lastNpcLiquidation) next.lastNpcLiquidation = LastOperations.normalize(next.lastNpcLiquidation, { field: 'sold' });
    if (Array.isArray(next.huntEfficiency)) next.huntEfficiency = next.huntEfficiency.map(row => {
        const rounded = { ...row };
        for (const key of ['exp', 'kills']) if (typeof rounded[key] === 'number') rounded[key] = significant(rounded[key]);
        for (const key of ['adena', 'loot']) if (Number.isFinite(rounded[key])) rounded[key] = Math.round(rounded[key]);
        // Played hours, timestamps and cycle duration retain their exact values.
        return rounded;
    });
    return next;
}

// The mind: what the background thread decided for the bot (its stats packet
// and published card). It is saved in its own column (bot_life_state.mindJson),
// so a refused body write never takes the decision with it.
// woken, waiting, situationSeq: the bot's woken decisions (Situations, their one owner); earning: the earning
// spot's held answer (EquipmentIncomeRoute.answerOf); spotMarks: the spots its situations ruled out until
// the next held answer (SpotRiskPolicy.withSpotMark, written by Situations' raise); cleanupDue: the bag's
// town trip a build decided, held until it starts (PartyMarketBreak.cleanupDecision); rebuff: the rebuff
// decision's held answer (Bot/AI/Rebuff); huntSpot: the spot the bot goes to when sent to hunt, the
// route's choice with what it was chosen on ({ spotId, plan, earning }, BotRoute.huntSpotHeld).
const MIND_KEYS = Object.freeze(['decisionSeq', 'activityLeaf', 'wishFocus', 'wishSections',
    'dormantWishes', 'money', 'kitRates', 'dangerPrice', 'wishAdvisory', 'woken', 'waiting', 'situationSeq', 'earning',
    'spotMarks', 'gearMarks', 'cleanupDue', 'rebuff', 'huntSpot']);

// A whole stats object (or a stats patch) as its two saved halves.
// Keys no owner keeps any more, dropped as an old row saves again: wishDirty (the build's
// sections, gone with the build on situations, step 4 C6).
const RETIRED_KEYS = Object.freeze(['wishDirty', 'mammonRetryAt']);
function split(stats = {}) {
    const body = compact(stats), mind = {};
    for (const key of RETIRED_KEYS) delete body[key];
    for (const key of MIND_KEYS) {
        if (!Object.hasOwn(body, key)) continue;
        mind[key] = body[key];
        delete body[key];
    }
    return { body, mind };
}

function parsedObject(json) {
    if (!json) return {};
    if (typeof json === 'object') return { ...json };
    try {
        const value = JSON.parse(json);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) {
        return {};
    }
}

// A saved body (text or its parse) as a stats object, its kit's skill records
// unpacked (SavedSkills): a copy, the given object is not changed.
function body(statsJson) {
    const stats = parsedObject(statsJson);
    if (SavedSkills.packed(stats.coldCombat?.skills)) stats.coldCombat = SavedSkills.unpackKit(stats.coldCombat);
    return stats;
}

// The one stats object of a saved row: the mind over the body. A row without
// a mind column (a transient row, an older fixture) is its body alone.
function merge(statsJson, mindJson) {
    const stats = body(statsJson);
    if (!mindJson || mindJson === '{}') return stats;
    return Object.assign(stats, parsedObject(mindJson));
}

// The two columns a whole-stats writer saves.
function statsColumns(stats) {
    const { body, mind } = split(stats || {});
    return { statsJson: JSON.stringify(body), mindJson: JSON.stringify(mind) };
}

module.exports = { compact, MIND_KEYS, split, parsedObject, body, merge, statsColumns };
