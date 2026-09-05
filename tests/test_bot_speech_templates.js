const assert = require('assert');
const fs = require('fs');
const espree = require('espree');
require('../src/Global');
const Speech = invoke('GameServer/Bot/AI/BotSpeechTemplates');
const BotAI = invoke('GameServer/Bot/BotAI');
const TownChatter = invoke('GameServer/Bot/AI/TownChatter');
const Budget = invoke('GameServer/Bot/AI/BotChatterBudget');

const values = { item: 'Sword of Revolution', seller: 'Graham', count: 0 };
const purchased = Speech.lines('town.npc-gear-purchased', values);
assert(purchased.length >= 3);
assert(purchased.every(text => text.includes(values.item) && !/Upgrade found|equipped|secured/.test(text)),
    'purchase chatter should sound conversational and must not assert an unconfirmed equip');
assert(Speech.lines('town.supply-purchased', values).some(text => text.includes('0')),
    'zero is a valid supplied value, not a missing placeholder');
assert.deepStrictEqual(Speech.lines('town.npc-gear-purchased'), [], 'missing item data must not leak template tokens');
assert.deepStrictEqual(Speech.lines('missing-key'), []);
assert(Speech.lines('town.supply-return.ready').every(text => !/delivered|complete/i.test(text)),
    'arriving at camp is not the same as transferring supplies');

// Validate production call sites against the catalogue, including alternate
// failure branches. A typo or omitted argument otherwise silently loses chat.
const files = [
    'AI/States/ShoppingState.js', 'AI/States/GettingBuffedState.js', 'AI/States/HuntingState.js',
    'AI/States/RestingState.js', 'AI/BotTownTravel.js', 'AI/BotConversation.js',
    'Population/BotGlobalChat.js', 'BotAI.js'
];
let checked = 0;
for (const file of files) {
    const tree = espree.parse(fs.readFileSync(`src/GameServer/Bot/${file}`, 'utf8'), { ecmaVersion: 'latest' });
    function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
            node.callee.object.name === 'Speech' && node.arguments[0]?.type === 'Literal') {
            const key = node.arguments[0].value;
            assert(Object.hasOwn(Speech.catalog, key), `${file}: unknown speech key ${key}`);
            const supplied = new Set((node.arguments[1]?.properties || []).map(property => property.key.name));
            const flags = new Set((node.arguments[2]?.properties || []).map(property => property.key.name));
            for (const variant of Speech.catalog[key]) {
                if (typeof variant !== 'string') assert(flags.has(variant.when), `${key}: missing condition ${variant.when}`);
                for (const text of typeof variant === 'string' ? [variant] : [variant.yes, variant.no]) {
                    for (const match of text.matchAll(/\{(\w+)\}/g)) assert(supplied.has(match[1]), `${key}: missing ${match[1]}`);
                }
            }
            checked++;
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value === 'object') walk(value);
        }
    }
    walk(tree);
}
assert(checked >= 60);
assert(BotAI.getRandomPhrase('foundTarget', 'Keltir').includes('Keltir'));
assert(BotAI.getRandomPhrase('victory'));

Budget.reset();
const messages = [];
const solo = { actor: { fetchId: () => 21 } };
const ai = { say(_session, text) { messages.push(text); } };
assert(TownChatter.say(solo, ai, 'npc-gear-purchased', purchased, { now: 100000 }));
assert(!TownChatter.say(solo, ai, 'npc-gear-purchased', purchased, { now: 100001 }));
assert.strictEqual(messages.length, 1, 'external templates must retain the existing topic cooldown');
assert(purchased.includes(messages[0]));
Budget.reset();
console.log(`Speech catalogue checks passed (${checked} production references)`);
