#!/usr/bin/env node
'use strict';

// The hunt cycle model (GameServer/Bot/AI/HuntCycle) against the author's
// cold combat (BackgroundResolver.resolveSolo, through the spot table
// generator's hunt) on sample bots: the reference kit and kits that differ
// from it, each on the spot the model ranks first for it. Per case: kills per
// hour the fights allow (no spot cap: the generator hunts an unlimited
// spot), fight and rest seconds per kill, net adena per hour at NPC prices.
// Usage: node scripts/hunt-cycle-check.js [--hours=2]

const fs = require('fs');
const path = require('path');
const Generator = require('./generate-spot-table');

const hours = Number((process.argv.find(arg => arg.startsWith('--hours=')) || '--hours=2').split('=')[1]);
const root = path.resolve(__dirname, '..');
const without = (...slots) => bot => {
    for (const [key, row] of Object.entries(bot.inventory)) if (slots.includes(Number(row.slot))) delete bot.inventory[key];
};
const wearing = (selfId, slot, free = [slot]) => bot => {
    without(...free)(bot);
    bot.inventory[`kit-${selfId}`] = { selfId, amount: 1, equipped: true, equippedCount: 1, equippedSlots: [slot], slot };
};
const CASES = [
    ['dps', 30, 'reference', null],
    ['dps', 30, 'no helmet', without(6)],
    ['dps', 30, 'no chest, no legs', without(10, 11)],
    ['mage', 30, 'reference', null],
    ['mage', 30, 'no chest', without(10)],
    ['dps', 45, 'reference', null],
    ['dps', 45, 'D dual (Bastard*Crimson)', wearing(2529, 14, [7, 8, 14])],
    ['tank', 45, 'no shield', without(8)]
];

function main() {
    const catalogue = Generator.buildCatalogue();
    const file = path.join(root, 'tmp', `hunt-cycle-catalogue-${process.pid}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ spots: catalogue.spots, profiles: catalogue.profiles }));
    try {
        Generator.loadSimulation(file);
        const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
        const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
        const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
        const profiles = new Map(catalogue.profiles.map(spot => [spot.id, spot]));
        const lines = [['role', 'level', 'kit', 'spot', 'kills/h model', 'sim', 'fight s model', 'sim', 'rest s model', 'sim',
            'income/h model', 'sim'].join('\t')];
        for (const [role, level, label, kit] of CASES) {
            const state = HuntCycle.referenceState(Generator.classFor(role, level), level, { line: Generator.lineClassFor(role) });
            state.stats.role = role;
            if (kit) kit(state);
            const numbers = Profile.profileFor(state, 0, { store: false });
            const reader = HuntCycle.reader(state, {});
            if (!reader.spotIds.length) { lines.push(`${role}\t${level}\t${label}\tno table row`); continue; }
            let best = 0;
            for (let index = 1; index < reader.spotIds.length; index++) {
                if (reader.hourAt(numbers, index).income > reader.hourAt(numbers, best).income) best = index;
            }
            const model = reader.hourAt(numbers, best), spotId = reader.spotIds[best];
            const sum = Generator.hunt(profiles.get(spotId), role, level, 1, hours, undefined, kit);
            const prices = Hunt.consumablePrices(state);
            const net = sum.adena + sum.loot - sum.shots * prices.shots - sum.potions * prices.potions;
            const k = Math.max(1, sum.kills);
            const fixed = value => Number(value).toFixed(1);
            lines.push([role, level, label, spotId, fixed(model.own), fixed(sum.kills / hours), fixed(model.fight),
                fixed(sum.fightMs / 1000 / k), fixed(model.rest), fixed(sum.restMs / 1000 / k),
                fixed(model.income / model.kills * model.own), fixed(net / hours)].join('\t'));
            process.stderr.write(`${lines.at(-1)}\n`);
        }
        process.stdout.write(`${lines.join('\n')}\n`);
    } finally {
        fs.rmSync(file, { force: true });
    }
    process.exit(0);
}

main();
