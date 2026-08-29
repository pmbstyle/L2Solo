const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const ProgressionRates = invoke('GameServer/ProgressionRates');
const { createKnowledgeBaseService, itemCategory, playerFacingItem, spawnMapPoints } = require('../src/WorldObserver/KnowledgeBaseService');

const previousPreset = process.env.L2NODE_PROGRESSION_RATE;
const dataDir = path.join(__dirname, '..', 'data', 'KnowledgeBase');
const service = createKnowledgeBaseService({
    dataDir,
    progressionRates: ProgressionRates,
    iconFor: (item, id) => ({ url: `/observer/item-icons/${Number(id)}.png` })
});

try {
    process.env.L2NODE_PROGRESSION_RATE = 'x1';
    const meta = service.meta();
    assert.strictEqual(meta.counts.items, 5062);
    assert.strictEqual(meta.counts.mobs, 2068);
    assert.strictEqual(meta.rateProfile.drop, 1);

    const itemSearch = service.listItems({ q: 'short sword', limit: 10 });
    assert.deepStrictEqual(itemSearch.items.map((item) => item.id), [1]);
    assert.strictEqual(itemSearch.items[0].category, 'weapons');
    assert.strictEqual(itemSearch.items[0].iconUrl, '/observer/item-icons/1.png');
    assert.strictEqual(itemCategory('Other.Material'), 'materials');
    assert.strictEqual(playerFacingItem({ name: '_' }), false);
    assert.strictEqual(playerFacingItem({ name: '(Not used) Cord' }), false);
    assert.strictEqual(playerFacingItem({ name: 'Short Sword' }), true);

    const npcPage = service.listNpcs({ minLevel: 1, maxLevel: 2, limit: 100 });
    assert.ok(npcPage.items.length > 0);
    assert.ok(npcPage.items.every((npc) => npc.level >= 1 && npc.level <= 2));
    assert.deepStrictEqual([...npcPage.items].sort((left, right) => left.level - right.level), npcPage.items);

    const shortSword = service.itemDetail(1);
    const blackWolf = shortSword.sources.drops.find((npc) => npc.id === 317);
    assert.strictEqual(blackWolf.chancePercent, 0.6187);

    const gremlinX1 = service.npcDetail(1);
    assert.strictEqual(gremlinX1.drops[1].items[0].chancePercent, 6.99759273);
    assert.ok(gremlinX1.spawns.flatMap((spawn) => spawn.mapPoints).length > 0);

    process.env.L2NODE_PROGRESSION_RATE = 'x50';
    const gremlinX50 = service.npcDetail(1);
    assert.strictEqual(gremlinX50.rateProfile.drop, 50);
    assert.strictEqual(gremlinX50.drops[1].items[0].chancePercent, 33.49182068);
    assert.strictEqual(gremlinX50.spoils[0].items[0].chancePercent, 12.0603);
    assert.strictEqual(gremlinX50.spoils[0].items[0].expectedAmountPerKill, 6.03015);

    assert.deepStrictEqual(spawnMapPoints({ possibleLocations: [{ locX: 10, locY: 20, locZ: -30 }] }), [
        { locX: 10, locY: 20, locZ: -30, source: 'location' }
    ]);
    assert.deepStrictEqual(spawnMapPoints({ zone: { id: 'test', bounds: [
        { locX: 0, locY: 10, minZ: -20, maxZ: 0 },
        { locX: 20, locY: 30, minZ: -40, maxZ: -20 }
    ] } }), [{ locX: 10, locY: 20, locZ: -20, source: 'zone', zoneId: 'test' }]);

    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'WorldObserver', 'public', 'knowledge-base.html'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'WorldObserver', 'public', 'knowledge-base.js'), 'utf8');
    const mapHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'WorldObserver', 'public', 'index.html'), 'utf8');
    assert.match(html, /Aden Archives/);
    assert.match(html, /data-kind="items"/);
    assert.match(html, /data-kind="npcs"/);
    assert.match(app, /\/observer\/api\/knowledge\/\$\{state\.kind\}/);
    assert.match(app, /Show .* locations on map/);
    assert.match(mapHtml, /href="\/observer\/database\/items"/);
    assert.match(mapHtml, /id="npcSpawnLayer"/);
} finally {
    if (previousPreset === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
    else process.env.L2NODE_PROGRESSION_RATE = previousPreset;
}

console.log('World observer knowledge base checks passed');
