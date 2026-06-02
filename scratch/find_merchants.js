const fs = require('fs');

const npcs = JSON.parse(fs.readFileSync('./data/Npcs/npcs.json', 'utf-8'));

// Filter all merchants that might be in starter towns
const results = npcs.filter(npc => 
    npc.template && 
    npc.template.kind === 'Merchant' &&
    npc.selfId >= 7000 && npc.selfId < 8000
);

console.log("=== Merchants in range 7000-8000 ===");
results.forEach(npc => {
    console.log(`ID: ${npc.selfId} | Name: ${npc.template.name} | Title: ${npc.template.title}`);
});
