// Import the timed water walls, excluding the five separately controlled secret doors.
const fs = require('fs');
const path = require('path');
const revision = 'fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975';
const source = `https://gitlab.com/TheDnR/l2j-lisvus/-/raw/${revision}/datapack/data/doors.xml`;
const root = path.resolve(__dirname, '..');
const xml = fs.readFileSync(process.argv[2] || path.join(root, 'tmp/vendor/l2j-lisvus/datapack/data/doors.xml'), 'utf8');
const doors = [...xml.matchAll(/<door id="(\d+)" name="([^"]+)">([\s\S]*?)<\/door>/g)]
    .filter(([, id]) => Number(id) >= 22250001 && Number(id) <= 22250024)
    .map(([, id, name, body]) => {
        const values = Object.fromEntries([...body.matchAll(/<set name="([^"]+)" val="([^"]+)"/g)]
            .map(([, key, value]) => [key, Number(value)]));
        const dimensions = body.match(/<dimensions\s+([^>]+)\/>/)[1];
        const bounds = Object.fromEntries([...dimensions.matchAll(/(min|max)(X|Y|Z)="(-?\d+)"/g)]
            .map(([, side, axis, value]) => [`${side}${axis}`, Number(value)]));
        if (values.autoOpenDelay !== 420000 || values.autoCloseDelay !== 420000)
            throw Error(`Unexpected C4 water wall timing: ${id}`);
        return { id: Number(id), name, locX: values.x, locY: values.y, locZ: values.z,
            maxHp: values.baseHpMax, autoOpenDelay: values.autoOpenDelay, autoCloseDelay: values.autoCloseDelay, bounds };
    });
if (doors.length !== 24 || new Set(doors.map(door => door.id)).size !== 24)
    throw Error('Expected all 24 C4 Garden of Eva water walls');
fs.mkdirSync(path.join(root, 'data/World'), { recursive: true });
fs.writeFileSync(path.join(root, 'data/World/garden_of_eva_doors.json'), JSON.stringify({ source, revision, doors }, null, 2) + '\n');
console.info(`Imported ${doors.length} Garden of Eva water walls from Lisvus C4 ${revision}`);
