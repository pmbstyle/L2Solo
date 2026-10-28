const assert = require('assert');
const { useRate } = require('./helpers/progressionRate');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const ProgressionRates = invoke('GameServer/ProgressionRates');
const { createKnowledgeBaseService, itemCategory, npcCombatTraits, playerFacingItem, spawnMapPoints } = require('../src/WorldObserver/KnowledgeBaseService');
const { createExportedCatalogue } = require('../src/GameServer/Knowledge/ExportedCatalogueAdapter');
const { create } = require('../src/GameServer/Knowledge/GameDataCatalogue');
const DataCache = invoke('GameServer/DataCache'), NativeRecipes = require('../src/GameServer/Items/C4RecipeItems');
const beforeNative = { items: DataCache.items, npcs: DataCache.npcs, spawns: DataCache.npcSpawns, recipes: NativeRecipes.loadedSource() };
let ownedExport, itemReads = 0, npcReads = 0;

const previousPreset = process.env.L2NODE_PROGRESSION_RATE;
const dataDir = path.join(__dirname, '..', 'data', 'KnowledgeBase');
const service = createKnowledgeBaseService({
    dataDir,
    progressionRates: ProgressionRates,
    iconFor: (item, id) => ({ url: `/observer/item-icons/${Number(id)}.png` }),
    catalogueFactory: (data, options) => {
        ownedExport = data;
        const catalogue = createExportedCatalogue(data, options);
        return { ...catalogue, item: id => { itemReads++; return catalogue.item(id); },
            npc: id => { npcReads++; return catalogue.npc(id); } };
    }
});

try {
    useRate('x1');
    const meta = service.meta();
    assert.strictEqual(meta.counts.items, require('../data/KnowledgeBase/manifest.json').counts.items);
    assert.strictEqual(meta.counts.mobs, require('../data/KnowledgeBase/manifest.json').counts.mobs);
    assert.strictEqual(meta.rateProfile.drop, 1);
    assert.deepStrictEqual(meta.npcFilters.weaknesses.map(({ key }) => key), [
        'blunt', 'holy', 'bow', 'fire', 'water', 'wind', 'earth', 'dark'
    ]);
    assert.deepStrictEqual(meta.npcFilters.hpMultipliers.map(({ value }) => value), [0.5, 2, 3, 4, 5, 6, 9]);
    const weaponDirectory = meta.itemDirectory.find((entry) => entry.key === 'weapons');
    // Regeneration includes the branch's existing C4 special-ability variants.
    assert.strictEqual(weaponDirectory.total, 858);
    assert.strictEqual(weaponDirectory.grades.find((grade) => grade.key === 'd').count, 121);
    assert.deepStrictEqual(meta.itemDirectory.find((entry) => entry.key === 'materials').grades, [
        { key: 'no-grade', count: 606 }
    ]);

    const itemSearch = service.listItems({ q: 'short sword', limit: 10 });
    const skillSearch = service.listSkills({ q: 'NPC Wind Strike', limit: 6 });
    assert(skillSearch.items.some(skill => skill.name === 'NPC Wind Strike'));
    const skillDetail = service.skillDetail(skillSearch.items.find(skill => skill.name === 'NPC Wind Strike').id);
    assert.strictEqual(skillDetail.name, 'NPC Wind Strike');
    assert(skillDetail.observation.includes('not proof this bot learned'));
    const nativeSkillService = createKnowledgeBaseService({ dataDir, progressionRates: ProgressionRates,
        nativeSkills: () => [{ selfId: 3, template: { name: 'Power Strike', distance: 50 }, levels: [{ level: 1, mp: 10, power: 25 }, { level: 2, mp: 10, power: 27 }] }] });
    assert(nativeSkillService.listSkills({ q: 'Power Strike' }).items.some(skill => skill.id === 3 && skill.name === 'Power Strike'));
    assert.strictEqual(nativeSkillService.skillDetail(3).levelCount, 2);
    assert.strictEqual(nativeSkillService.skillDetail(3).mpCost, 10);
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

    const fireAndX2 = service.listNpcs({ weakness: 'fire', hpMultiplier: '2', limit: 100 });
    assert.ok(fireAndX2.items.length > 0);
    assert.ok(fireAndX2.items.every((npc) => npc.weaknesses.includes('fire') && npc.hpMultiplier === 2));
    assert.ok(fireAndX2.items.some((npc) => npc.id === 81), 'Ant Overseer must match its passive fire weakness and x2 HP');
    const halfHp = service.listNpcs({ hpMultiplier: '0.5', limit: 100 });
    // 44 before the high-grade C4 slices added 11 half-HP group leaders,
    // 55 before the group leaders' minions added 21 half-HP minions,
    // 76 before the Mobius spawns brought 16 more with their Lisvus templates (T43),
    // 92 before the Mobius minion rows brought 3 more half-HP minions (T48).
    assert.strictEqual(halfHp.total, 95);
    assert.ok(halfHp.items.every((npc) => npc.hpMultiplier === 0.5));
    assert.strictEqual(service.listNpcs({ q: 'Marsh Stalker', weakness: 'fire' }).total, 0,
        'an active fire-weakness debuff must not be treated as the caster weakness');
    const elementalWeaknesses = service.listNpcs({ weakness: 'earth,water', limit: 100 });
    assert.ok(elementalWeaknesses.items.length > 0);
    assert.ok(elementalWeaknesses.items.every((npc) => npc.weaknesses.some((key) => ['earth', 'water'].includes(key))),
        'multiple weaknesses must use OR semantics');

    assert.deepStrictEqual(npcCombatTraits({ skillIds: ['active', 'passive'] }, new Map([
        ['active', { passive: false, semantic: { target: 'enemy', stats: { fireVuln: 1.5, maxHpMul: 9 } } }],
        ['passive', { passive: true, semantic: { target: 'self', stats: { bowWpnVuln: 1.2, maxHpMul: 3 } } }]
    ])), { weaknesses: ['bow'], hpMultiplier: 3 });

    const shortSword = service.itemDetail(1);
    assert.deepStrictEqual(service.itemOverview(1), {
        id: shortSword.id,
        name: shortSword.name,
        kind: shortSword.kind,
        category: shortSword.category,
        grade: shortSword.grade,
        price: shortSword.price,
        iconUrl: shortSword.iconUrl,
        hasDropSources: shortSword.hasDropSources,
        hasSpoilSources: shortSword.hasSpoilSources,
        sourceCount: shortSword.sourceCount
    });
    const blackWolf = shortSword.sources.drops.find((npc) => npc.id === 317);
    assert.strictEqual(blackWolf.chancePercent, 0.6187);
    const exported = service.catalogue();
    assert.equal(exported.item(1), ownedExport.itemById.get(1));
    assert.equal(exported.sourcesForItem(1, { kind: 'drop' }), ownedExport.itemById.get(1).sources.drops);
    assert.equal(exported.sourcesForItem(1), null);
    assert.equal(exported.potentialSpawnData().definitions, ownedExport.spawns);
    assert.deepEqual(service.relations('item', 1, { spots: [] }), { kind: 'item', id: 1, origin: 'exported',
        recipes: { available: false, origin: null, revision: null, producedBy: null, usedBy: null },
        sources: { available: true, origin: 'exported', revision: ownedExport.manifest?.generatedAt || null,
            drops: ownedExport.itemById.get(1).sources.drops, spoils: ownedExport.itemById.get(1).sources.spoils },
        selectedSources: { available: false, origin: null, revision: null, rows: null } });
    assert.equal(exported.recipesForProduct(1), null, 'missing recipe data is unavailable, not an empty recipe list');
    const fixtureRecipes = [{ recipeId: 7, productId: 1 }], fixtureSpots = [{ spot: { id: 'selected' }, count: 0 }];
    const nativeFixture = create({ origin: 'native-fixture',
        capabilities: ({ spots } = {}) => ({ recipes: true, selectedSpots: Array.isArray(spots), npcShops: false, potentialSpawns: true }),
        recipesForProduct: () => fixtureRecipes, recipesUsing: () => [], selectedNpcSpots: () => fixtureSpots,
        selectedSourcesForItem: () => [] });
    const combined = createExportedCatalogue(ownedExport, { nativeCatalogue: nativeFixture });
    assert.equal(combined.recipesForProduct(1), fixtureRecipes);
    assert.equal(combined.relations('npc', 317, { spots: [] }).selectedSpots.rows, fixtureSpots);
    assert.equal(combined.item(1), exported.item(1), 'explicit native relations do not replace exported legacy detail rows');

    const mobs = require('../data/KnowledgeBase/mobs.json');
    const mobById = new Map(mobs.map(npc => [npc.id, npc]));
    let checkedRelations = 0;
    for (const npc of mobs.filter(npc => npc.minions?.length || npc.minionOf?.length)) {
        const detail = service.npcDetail(npc.id);
        for (const [field, idField] of [['minions', 'minionId'], ['minionOf', 'bossId']]) {
            const relations = npc[field] || [];
            assert.strictEqual(detail[field].length, relations.length);
            relations.forEach((relation, index) => {
                const expected = mobById.get(Number(relation[idField] ?? relation));
                assert.ok(expected, 'raid relations must reference a real NPC');
                assert.strictEqual(detail[field][index].id, expected.id);
                assert.strictEqual(detail[field][index].name, expected.name);
                assert.strictEqual(detail[field][index].level, expected.level);
                checkedRelations++;
            });
        }
    }
    assert.ok(checkedRelations > 0, 'exercise both minion and parent raid links from the generated catalog');

    const gremlinX1 = service.npcDetail(1);
    assert.strictEqual(gremlinX1.drops[1].items[0].chancePercent, 6.99759273);
    // Gremlin has no C4 spawn (Mobius places none, T43); a spawned mob shows its points.
    assert.deepStrictEqual(gremlinX1.spawns, []);
    assert.ok(service.npcDetail(558).spawns.flatMap((spawn) => spawn.mapPoints).length > 0);

    useRate('x50');
    const gremlinX50 = service.npcDetail(1);
    assert.strictEqual(gremlinX50.rateProfile.drop, 50);
    assert.strictEqual(gremlinX50.drops[1].items[0].chancePercent, 33.49182068);
    assert.strictEqual(gremlinX50.spoils[0].items[0].chancePercent, 12.0603);
    assert.strictEqual(gremlinX50.spoils[0].items[0].expectedAmountPerKill, 6.03015);
    const keltirAdena = service.npcDetail(481).drops.flatMap((group) => group.items)
        .find((item) => item.itemId === 57);
    assert.deepStrictEqual({
        min: keltirAdena.minAmount,
        max: keltirAdena.maxAmount,
        chance: keltirAdena.chancePercent,
        expected: keltirAdena.expectedAmountPerKill
    }, { min: 245, max: 350, chance: 100, expected: 297.5 });

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
    assert.match(html, /id="npcWeaknessFilter"/);
    assert.match(html, /id="npcHpMultiplierFilter"/);
    assert.match(html, /id="itemDirectory"/);
    assert.doesNotMatch(html, /id="itemCategory"/);
    assert.doesNotMatch(html, /Browse by type and grade/);
    assert.match(app, /\/observer\/api\/knowledge\/\$\{state\.kind\}/);
    assert.match(app, /function showItemDirectory\(\)/);
    assert.match(app, /data-item-category=/);
    assert.match(app, /number\(Math\.round\(Number\(npc\.expectedAmountPerKill/);
    assert.doesNotMatch(app, /expectedAmountPerKill \|\| 0\)\.toFixed\(4\)/);
    assert.match(app, /Show .* locations on map/);
    assert.match(app, /params\.set\('weakness', state\.weaknesses\.join\(','\)\)/);
    assert.match(app, /params\.set\('hpMultiplier', state\.hpMultipliers\.join\(','\)\)/);
    assert.match(app, /npcCombatTraitMarkup\(npc\)/,
        'NPC detail cards must show their HP multiplier and weakness badges');
    assert.match(app, /Weak to \$\{text\(npcWeaknessLabel\(key\)\)\}/,
        'NPC detail weakness labels must reuse the searchable filter vocabulary');
    assert.match(app, /\], \{ whole: true \}\)\}/,
        'NPC detail stat grids must render whole values');
    assert.match(mapHtml, /href="\/observer\/database\/items"/);
    assert.match(mapHtml, /id="npcSpawnLayer"/);
    assert(itemReads > 1 && npcReads > 1, 'actual reference detail readers call the common interface');
    assert.deepEqual({ items: DataCache.items, npcs: DataCache.npcs, spawns: DataCache.npcSpawns, recipes: NativeRecipes.loadedSource() }, beforeNative,
        'standalone exported reference never initializes the native datapack/recipe source');
} finally {
    useRate(previousPreset);
}

console.log('World observer knowledge base checks passed');
