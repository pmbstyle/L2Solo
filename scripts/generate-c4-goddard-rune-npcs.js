const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const vendor = path.join(root,'tmp/vendor/l2j-lisvus');
const revision = 'fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975';
if(execFileSync('git',['rev-parse','HEAD'],{cwd:vendor,encoding:'utf8'}).trim()!==revision) throw Error('Unexpected reference revision');
function tuple(line) {
    if(!line.startsWith('(')) return null;
    const values=[];let value='',quoted=false,escaped=false;
    for(let i=1;i<line.length;i++) {
        const c=line[i];
        if(escaped){value+=c;escaped=false;continue;}
        if(c==='\\' && quoted){escaped=true;continue;}
        if(c==="'"){quoted=!quoted;continue;}
        if(!quoted && (c===',' || c===')')) {const s=value.trim();values.push(/^[-+]?\d+(\.\d+)?$/.test(s)?Number(s):s);value='';if(c===')')return values;}
        else value+=c;
    }
    return null;
}
const read=name=>fs.readFileSync(path.join(vendor,'datapack/sql',name),'utf8').split(/\r?\n/).map(tuple).filter(Boolean);


// C4 city interiors and their entrance guards; castle siege objects are excluded.
const towns = [
    { name: 'Goddard', key: 'c4_goddard', box: [143000, 153500, -62000, -51000] },
    { name: 'Rune', key: 'c4_rune', box: [33000, 47000, -53000, -43000] }
];
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const output = 'data/Npcs/c4_goddard_rune.json';
const previousIds = new Set(fs.existsSync(path.join(root, output))
    ? JSON.parse(fs.readFileSync(path.join(root, output), 'utf8')).map(npc => npc.selfId) : []);
const existingIds = new Set(DataCache.npcs.filter(npc => !previousIds.has(npc.selfId)).map(npc => npc.selfId));
const existingSpawns = DataCache.npcSpawns.filter(group => !towns.some(town => town.key === group.selfId)).flatMap(group => group.spawns);
const sourceNpcs = read('npc.sql');
const byId = new Map(sourceNpcs.map(row => [row[0], row]));
// Lisvus adds Adventure Guild Members 8775-8841 beyond the stock C4
// client's NPC table. Reuse C4 guildsmen with the exact same model class;
// the server ID still owns their spawns, dialogue and quest routing.
const c4GuildDisplayIds = new Map(sourceNpcs.filter(row => row[0] >= 8729 && row[0] <= 8738)
    .map(row => [row[6], row[1]]));
const residentTypes = new Set(['L2Adventurer', 'L2ManorManager', 'L2ClanHallManager', 'L2Doormen',
    'L2Npc', 'L2Trainer', 'L2VillageMaster', 'L2SignsPriest', 'L2Guard', 'L2Teleporter',
    'L2Merchant', 'L2Warehouse', 'L2TownPet', 'L2SymbolMaker', 'L2Fisherman', 'L2OlympiadManager', 'L2Auctioneer']);
const groups = towns.map(town => {
    const [minX, maxX, minY, maxY] = town.box;
    const rows = read('spawnlist.sql').filter(row => row[4] > minX && row[4] < maxX && row[5] > minY && row[5] < maxY
        && residentTypes.has(byId.get(row[3])?.[11]));
    if (!rows.length) throw Error('No residents in ' + town.name);
    const spawns = rows.filter(row => !existingSpawns.some(spawn => spawn.selfId === row[3]
        && spawn.coords.some(c => c.locX === row[4] && c.locY === row[5] && c.locZ === row[6])))
        .map(row => ({ selfId: row[3], name: byId.get(row[3])[2],
            coords: [{ locX: row[4], locY: row[5], locZ: row[6], head: row[9] }], total: row[2], respawn: row[10], bias: 0 }));
    return { selfId: town.key, bounds: [], spawns };
});
const ids = new Set(groups.flatMap(group => group.spawns.map(spawn => spawn.selfId)));
const missingIds = new Set([...ids].filter(id => !existingIds.has(id)));
const npcs = sourceNpcs.filter(row => missingIds.has(row[0])).map(row => {
    const [selfId,idTemplate,name,,title,,modelClass,radius,size,level,,type,atkRadius,maxHp,maxMp,revHp,revMp,str,con,dex,int,wit,men,exp,sp,pAtk,pDef,mAtk,mDef,atkSpd,aggro,castSpd,weapon,shield,,walk,run,clanName,helpRadius] = row;
    const displayId = type === 'L2Adventurer' && selfId >= 8775 && selfId <= 8841
        ? c4GuildDisplayIds.get(modelClass) : idTemplate;
    if (!displayId) throw Error('No C4 display model for NPC ' + selfId);
    return {
        // L2Guard's source aggro radius applies to PKs, not ordinary players.
        selfId, template: { ...(displayId !== selfId ? { displayId } : {}),
            kind: type.replace(/^L2/, ''), name, title, level, hostile: type !== 'L2Guard' && aggro > 0 },
        base: { str, con, dex, int, wit, men },
        stats: { pAtk, pAtkRnd: 30, pDef, mAtk, mDef, atkSpd, castSpd, atkRadius, accur: 4.75 },
        speed: { walk, run }, vitals: { maxHp, maxMp, revHp, revMp, corpseTime: 7000 },
        collision: { radius, size }, equipment: { weapon, shield, reuseTime: 0 },
        clan: { clanName: clanName === 'NULL' ? '' : clanName, helpRadius }, rewards: { exp, sp }
    };
});

const shopRows = read('merchant_shopids.sql');
const buyRows = read('merchant_buylists.sql');
const itemIds = new Set(DataCache.items.map(item => item.selfId));
const shops = {};
const omittedItems = [];
for (const npc of npcs.filter(npc => npc.template.kind === 'Merchant')) {
    const listIds = new Set(shopRows.filter(row => row[1] === npc.selfId).map(row => row[0]));
    const entries = new Map();
    for (const [selfId, price, listId] of buyRows) {
        if (!listIds.has(listId)) continue;
        if (!itemIds.has(selfId)) { omittedItems.push({ npcId: npc.selfId, selfId, listId }); continue; }
        if (!entries.has(selfId)) entries.set(selfId, { selfId, price });
    }
    if (entries.size) shops[npc.selfId] = [...entries.values()];
}
const write = (file, data) => fs.writeFileSync(path.join(root, file), JSON.stringify(data, null, 2) + '\n');
write(output, npcs);
write('data/Npcs/Spawns/c4_goddard_rune.json', groups);
write('data/Npcs/c4_goddard_rune_shops.json', shops);
write('data/Npcs/c4_goddard_rune_source.json', { revision, towns, omittedItems });
for (const npc of npcs) {
    const { name, title } = npc.template;
    const links = shops[npc.selfId] ? '<a action="bypass -h buy-shop npc">Buy goods</a><br>\n<a action="bypass -h sell-shop">Sell items</a><br>\n' : '';
    const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    fs.writeFileSync(path.join(root, 'data/Html', npc.selfId + '.html'), '<html><body>\n' + escape((title ? title + ' ' : '') + name) + ':<br>\n' + links + '<a action="bypass -h html ' + npc.selfId + '-quest">Quest</a>\n</body></html>\n');
}
console.log(JSON.stringify({ templates: npcs.length, spawns: groups.map(g => [g.selfId, g.spawns.length]), shops: Object.keys(shops).length, omittedItems: omittedItems.length }));
