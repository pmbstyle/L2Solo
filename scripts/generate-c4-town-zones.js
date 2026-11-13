// Import the C4 town zones: the town zones of L2J Lisvus (TownZone), each an
// outline on the map with its `peace` flag. Every town is a peace zone but
// Floran Village (townId 16), which stays open to PvP. The C4 sources
// disagree here: Lisvus L2TownZone.java leaves townId 16 out of peace, while
// L2J Mobius C4 zones/peace.xml covers Floran (floran_town_peace1-3). We
// follow Lisvus: our design names Floran the PK town, where a red name trades
// and shops (AFK trade opens in any town zone, peace or not).
// Usage: node scripts/generate-c4-town-zones.js [<Lisvus townZones.xml>]
const fs = require('fs');
const path = require('path');
const revision = '9b63d6857fedc769373fdd397d939601206852a7';
const source = `https://gitlab.com/TheDnR/l2j-lisvus/-/raw/${revision}/datapack/data/zones/townZones.xml`;
const root = path.resolve(__dirname, '..');
const FLORAN_TOWN_ID = 16;
const xml = fs.readFileSync(process.argv[2] || path.join(root, 'tmp/vendor/l2j-lisvus/datapack/data/zones/townZones.xml'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');
const towns = [...xml.matchAll(/<zone ([^>]*)>([\s\S]*?)<\/zone>/g)].map(([, head, body]) => {
    const attrs = Object.fromEntries([...head.matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
    const townId = Number(body.match(/<stat name="townId" val="(\d+)"/)[1]);
    const nodes = [...body.matchAll(/<node X="(-?\d+)" Y="(-?\d+)"/g)].map(([, x, y]) => ({ x: Number(x), y: Number(y) }));
    if (attrs.type !== 'TownZone') throw Error(`Unexpected zone type ${attrs.type} in ${attrs.name}`);
    // A cuboid is its two corners: written as the same outline as the others.
    const outline = attrs.shape === 'Cuboid'
        ? [{ x: nodes[0].x, y: nodes[0].y }, { x: nodes[1].x, y: nodes[0].y }, { x: nodes[1].x, y: nodes[1].y }, { x: nodes[0].x, y: nodes[1].y }]
        : nodes;
    if (!['NPoly', 'Cuboid'].includes(attrs.shape) || outline.length < 3) throw Error(`Unreadable town zone ${attrs.name}`);
    return { name: attrs.name, townId, outline };
});
if (towns.length !== 16 || new Set(towns.map((town) => town.townId)).size !== 16) throw Error('Expected the 16 C4 town zones');
fs.mkdirSync(path.join(root, 'data/World'), { recursive: true });
fs.writeFileSync(path.join(root, 'data/World/c4_town_zones.json'),
    `{"source":${JSON.stringify(source)},"revision":${JSON.stringify(revision)},"towns":[\n`
    + towns.map(({ name, townId, outline }) => JSON.stringify({ name, townId, peace: townId !== FLORAN_TOWN_ID, outline })).join(',\n') + '\n]}\n');
console.info(`Imported ${towns.length} town zones (${towns.filter((town) => town.townId !== FLORAN_TOWN_ID).length} peace) from Lisvus C4 ${revision}`);
