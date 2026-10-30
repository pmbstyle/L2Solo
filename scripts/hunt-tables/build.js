#!/usr/bin/env node
'use strict';

// The hunt model's tables (user 10-29): small precomputed tables in
// data/Bots/hunt/, the hunt numbers computed on demand by formula
// (HuntModel). Offline only; the server does not read them yet.
//
//   1 mobs        mob card: combat numbers (identical ones merged), exp, SP,
//                 danger type, drop and spoil groups
//   2 spots       spot card: mobs, counts, pulls, nearest town
//   3 classes     class base card: base stats, naked numbers per level,
//                 regeneration, passives, allowed weapon and armour kinds
//   4 rotation    class x 2-level band: damage per pAtk / sqrt(mAtk), MP use,
//                 shot multiplier, from the real cold fight on a dummy
//   5 gear        class x slot ladders (dominated pieces out), weapon and
//                 armour tiers
//   6 sources     item -> NPC shops, luxury shop, drops, spoils, recipes
//   8 corrections formula vs the real cold hunt, per rotation kind and danger
//   7 ceilings    class x band x weapon tier x armour tier x danger ->
//                 the highest mob level the bot can take on (reads 8)
//   9 henna       symbols, their deltas and price, classes' slots and symbols
//
// Usage: node scripts/hunt-tables/build.js [--tables=mobs,spots,...|all] [--sample=N]
// Run through ~/Games/tools/check.sh (background priority).

const C = require('./common');

const ORDER = ['mobs', 'spots', 'classes', 'gear', 'sources', 'henna', 'rotation', 'corrections', 'ceilings'];

function args() {
    const out = { tables: ORDER, sample: 0 };
    for (const arg of process.argv.slice(2)) {
        const [key, value] = arg.replace(/^--/, '').split('=');
        if (key === 'tables') out.tables = value === 'all' ? ORDER : value.split(',');
        else if (key === 'sample') out.sample = Number(value);
        else throw new Error(`unknown argument ${arg}`);
    }
    for (const table of out.tables) if (!ORDER.includes(table)) throw new Error(`unknown table ${table}`);
    return out;
}

function report(name, size, startedAt, counts) {
    process.stderr.write(`${name}: ${(size / 1024).toFixed(0)} KB, ${((Date.now() - startedAt) / 1000).toFixed(1)} s, ${JSON.stringify(counts)}\n`);
}

function main() {
    const options = args();
    C.boot();
    const S = require('./static-tables');
    const held = {};
    const table = name => held[name] || (held[name] = C.readTable(name));
    for (const name of ORDER.filter(name => options.tables.includes(name))) {
        const startedAt = Date.now();
        let body, counts, inputs = {};
        if (name === 'mobs') {
            body = S.buildMobs();
            counts = { mobs: body.mobs.length, combats: body.combats.length, rewards: body.rewards.length };
        } else if (name === 'spots') {
            body = S.buildSpots();
            counts = { spots: body.spots.length, spawned: body.spawned };
            delete body.spawned;
            inputs = { catalogueSeed: 20261005, periodMode: 'day' };
        } else if (name === 'classes') {
            body = S.buildClasses();
            counts = { classes: body.classes.length, rows: body.classes.length * C.MAX_LEVEL };
        } else if (name === 'gear') {
            body = S.buildGear(table('classes'));
            counts = { items: body.items.length, ladderRows: body.classes.reduce((sum, cls) => sum
                + Object.values(cls.slots).reduce((n, list) => n + list.length, 0), 0) };
        } else if (name === 'sources') {
            body = S.buildSources(table('mobs'), table('gear'));
            counts = { items: body.items.length };
        } else if (name === 'henna') {
            body = S.buildHenna(table('classes'));
            counts = { symbols: body.symbols.length, classes: body.classes.length };
        } else if (name === 'rotation') {
            const R = require('./rotation');
            ({ body, counts, inputs } = R.build(table('classes'), table('gear'), options));
        } else if (name === 'ceilings') {
            const K = require('./ceilings');
            ({ body, counts, inputs } = K.build(table('classes'), table('gear'), table('mobs'), table('rotation'), table('corrections')));
        } else if (name === 'corrections') {
            const K = require('./corrections');
            ({ body, counts, inputs } = K.build({ classes: table('classes'), gear: table('gear'), mobs: table('mobs'),
                rotation: table('rotation') }, options));
        }
        held[name] = body;
        const size = C.writeTable(name, { inputs, counts, startedAt }, body);
        report(name, size, startedAt, counts);
    }
    process.exit(0);
}

if (require.main === module) main();
