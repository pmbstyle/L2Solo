'use strict';

const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Catalog = invoke('GameServer/Skills/SkillBookCatalog');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

const a = { skillId: 1, damage: 1000, castSeconds: 2, periodSeconds: 8 };
const b = { skillId: 2, damage: 600, castSeconds: 1.5, periodSeconds: 4.5 };
near(Providers.rotationRate(100, [a]), (8000 + 4400) / 60);
near(Providers.rotationRate(100, [a, b]), (8000 + 8400 + 2300) / 60);
near(Providers.rotationRate(100, [b, a]), Providers.rotationRate(100, [a, b]));
near(Providers.rotationRate(100, []), 100);
near(Providers.rotationRate(100, [{ skillId: 3, damage: 20, castSeconds: .1, periodSeconds: .1 }]), 200);
assert(Providers.rotationRate(100, [a, b]) / Providers.rotationRate(100, [a]) - 1 > .5);

const mage = { characterId: 990013, phase: 'cold', activity: 'hunting', level: 45, adena: 0, sp: 1e6,
    inventory: {}, vitals: {}, stats: { classId: 12, exp: Data.experience[44], coldCombat: {
        classId: 12, skillSource: 'database', skills: Profile.skillSnapshotsFromRecords([{ selfId: 1230, level: 1 }])
    }, persona: { understanding: .8, traits: { commitment: .5, caution: .5, resilience: .5,
        ambition: .5, empathy: .5, sociability: .5, assertiveness: .5 } } } };
const ice = Catalog.missingBooks(mage).find(book => book.skillId === 1184);
assert(ice && Providers.skillGain(mage, ice).attack > 0, 'Ice Bolt adds a rotation after Prominence');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const context = Economy.forState(mage);
assert(context.projection.nodes.some(node => node.key === 'book:1184' && node.valueHours > 0),
    'a second actual Sorcerer nuke has a positive spellbook wish');
const book = context.projection.nodes.find(node => node.key === 'book:1184');
assert(book.benefitPerHour > 0 && Math.abs(book.benefitPerHour * book.horizonHours - book.valueHours) < 1e-6 * book.valueHours,
    'MVP-4: the spellbook benefit per hour over the common horizon H');
Economy.reset();
assert.equal(invoke('Database').isReady(), false);
console.log('Attack spellbooks: finite rotation, native second nuke and actual positive wish passed');
