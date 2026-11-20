#!/usr/bin/env python3
"""Import the three low C4 grand bosses from pinned, locally cached Lisvus sources.

Usage: python3 scripts/generate-c4-grand-bosses.py /path/to/source-cache
Cache filenames: npc.sql, npcskills.sql, droplist.sql, spawnlist.sql,
4000-4099.xml, 4500-4599.xml, 6600-6699.xml.
"""
import ast
import hashlib
import json
import math
import pathlib
import re
import sys
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = pathlib.Path(sys.argv[1])
REVISION = 'fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975'
BOSSES = {12001, 12052, 12169}
IDS = BOSSES | {12002, 12003, 12004, 12005, 12054, 12055, 12058, 12171, 12173}

def tuples(name):
    for line in (SOURCE / name).read_text().splitlines():
        if not re.match(r"\('?\d+'?,", line):
            continue
        yield ast.literal_eval(line.split(' --')[0].strip().rstrip(',;').replace('NULL', 'None'))

npcs = []
owners = {12002:12001, 12003:12001, 12004:12001, 12005:12001,
          12054:12052, 12055:12052, 12058:12052, 12171:12169, 12173:12169}
for row in tuples('npc.sql'):
    i = int(row[0])
    if i not in IDS:
        continue
    n = lambda at: float(row[at])
    hp = n(13)
    npcs.append(dict(selfId=i, template=dict(kind='Boss' if i in BOSSES else 'Monster',
        name=row[2], title=row[4], level=int(row[9]), hostile=n(30)>0,
        **({'raidBoss':True, 'grandBoss':True, 'raidCurse':False} if i in BOSSES
           else {'grandBossOwnerId':owners[i]}), ai=row[45]),
        traits={'race': {12001:'insect',12052:'construct',12169:'spirit'}.get(i,'undead' if n(39) else 'insect')},
        base=dict(str=n(17),con=n(18),dex=n(19),int=n(20),wit=n(21),men=n(22)),
        stats=dict(pAtk=n(25),pAtkRnd=30,pDef=n(26),mAtk=n(27),mDef=n(28),
                   accur=4.75,atkSpd=n(29),castSpd=n(31),atkRadius=n(12)),
        speed=dict(walk=n(35),run=n(36)),vitals=dict(maxHp=hp,maxMp=n(14),revHp=n(15),revMp=n(16),corpseTime=20000),
        collision=dict(radius=n(7),size=n(8)),equipment=dict(weapon=int(row[32]),shield=int(row[33]),reuseTime=0),
        clan=dict(clanName=row[37] or '',helpRadius=n(38)),
        rewards=dict(exp=round(int(row[23])/int(row[9])**2,9),sp=int(row[24]))))

skills = [dict(npcId=int(r[0]),skillId=int(r[1]),level=int(r[2])) for r in tuples('npcskills.sql') if int(r[0]) in IDS]
# These are script-cast skills. Binding the friendly heals also exposes the
# real healer capability to raid target selection; generic enemy AI ignores them.
skills += [dict(npcId=12003,skillId=4020,level=1),dict(npcId=12003,skillId=4024,level=1),
           dict(npcId=12173,skillId=4516,level=1)]
for npc in npcs:
    race = next((r['skillId'] for r in skills if r['npcId']==npc['selfId'] and 4290 <= r['skillId'] <= 4301),None)
    npc['traits']['race'] = {4290:'undead',4291:'construct',4292:'beast',4296:'spirit',4301:'insect'}.get(race,'unknown')
wanted = {4017,4018,4019,4020,4021,4024,4062,4063,4064,4067,4516}
templates=[]
for file in ['4000-4099.xml','4500-4599.xml']:
    for s in ET.parse(SOURCE/file).getroot():
        i=int(s.get('id',0))
        if i not in wanted:continue
        sets={v.get('name'):v.get('val') for v in s.findall('set')}
        tables={v.get('name'):list(map(float,(v.text or '').split())) for v in s.findall('table')}
        def value(key,index):
            v=sets.get(key,'0');return tables[v][index] if v in tables else float(v)
        templates.append(dict(selfId=i,template=dict(name=s.get('name'),passive=sets.get('operateType')=='OP_PASSIVE',
            spell=sets.get('isMagic')=='true',distance=value('castRange',0)),
            time=dict(hitTime=value('hitTime',0),reuse=value('reuseDelay',0) or value('coolTime',0),buff=0),
            levels=[dict(level=k+1,power=value('power',k),mp=value('mpConsume',k)+value('mpInitialConsume',k),hp=0,itemId=0,itemCount=0) for k in range(int(s.get('levels')))]))
items=[]
for item in ET.parse(SOURCE/'6600-6699.xml').getroot():
    i=int(item.get('id',0))
    if i not in {6660,6661,6662}:continue
    sets={v.get('name'):v.get('val') for v in item.findall('set')}
    adds={v.get('stat'):float(v.get('val')) for v in item.findall('./for/add')}
    items.append(dict(selfId=i,template=dict(kind='Armor.Jewel',name=item.get('name'),class1=1,class2=1,
        mass=int(sets['weight']),price=int(sets['price'])),stats=dict(pDef=0,mDef=adds['mDef'],evasion=0,maxMp=adds['maxMp']),
        etc=dict(slot=1 if i==6661 else 4,rank=sets['crystal_type'].lower(),cristals=int(sets['crystal_count']))))
epicDrops=[dict(npcId=int(r[0]),itemId=int(r[1]),min=int(r[2]),max=int(r[3]),category=int(r[4]),chance=int(r[5])/10000)
           for r in tuples('droplist.sql') if int(r[0]) in BOSSES and int(r[1]) in {6660,6661,6662}]
ambient=[]
for r in tuples('spawnlist.sql'):
    if int(r[3]) not in {12004,12171,12173}:continue
    ambient.append(dict(selfId=int(r[3]),name=next(n['template']['name'] for n in npcs if n['selfId']==int(r[3])),
        coords=[dict(locX=int(r[4]),locY=int(r[5]),locZ=int(r[6]),head=int(r[9]))],total=1,respawn=int(r[10]),bias=0))
coord=lambda x,y,z:dict(locX=x,locY=y,locZ=z,head=0)
minions=[dict(bossId=12001,minionId=12002,min=1,max=1,respawnMs=0,coords=[coord(-21600,179482,-5846)],passive=True),
 dict(bossId=12001,minionId=12003,min=8,max=8,respawnMs=10000,healer=True,coords=[coord(-22000,179482,-5846),coord(-21200,179482,-5846)]+
 [coord(-21610+int(400*math.cos(i*1.407)),181594+int(400*math.sin(i*1.407)),-5734) for i in range(6)]),
 dict(bossId=12001,minionId=12005,min=8,max=8,respawnMs=300000,respawnJitterMs=20000,offsets=[coord(int(400*math.cos(i*.7854)),int(400*math.sin(i*.7854)),0) for i in range(8)]),
 dict(bossId=12052,minionId=12054,min=10,max=10,respawnMs=60000,coords=[coord(16800+i*360,y,-6490) for i in range(5) for y in [110000,109000]]),
 dict(bossId=12052,minionId=12055,min=5,max=5,respawnMs=60000,coords=[coord(16800+i*600,109300,-6490) for i in range(5)]),
 dict(bossId=12052,minionId=12058,min=4,max=4,respawnMs=60000,coords=[coord(16800+i*450,110300,-6490) for i in range(4)]),
 dict(bossId=12169,minionId=12171,min=4,max=4,respawnMs=360000,offsets=[coord(x,y,0) for x,y in [(100,100),(100,-100),(-100,100),(-100,-100)]])]
for i in [12004,12171,12173]:
    count=sum(s['total'] for s in ambient if s['selfId']==i)
    minions.append(dict(bossId=owners[i],minionId=i,min=count,max=count,ambient=True,healer=i==12173,respawnMs=60000 if i!=12171 else 120000))
bundle=dict(revision=REVISION,source='https://gitlab.com/TheDnR/l2j-lisvus',
    sourceHashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(SOURCE.iterdir()) if p.is_file()},
    npcs=npcs,items=items,skillRows=skills,skillTemplates=templates,epicDrops=epicDrops,minions=minions,
    ambientSpawns=ambient,respawnHours={'12001':[36,17],'12052':[60,23],'12169':[48,20]},
    locations={'12001':[coord(-21610,181594,-5734)],'12052':[coord(17726,108915,-6490)],
               '12169':[coord(55024,17368,-5412),coord(53504,21248,-5486),coord(53248,24576,-5262)]},
    orfenLair=coord(43728,17220,-4342),
    orfenZone=[[43976,24664],[43284,18952],[42476,18164],[42480,16448],[43084,15944],[45140,15816],[48800,15112],[56556,12040],[59068,14288],[61064,18492],[60380,23672],[58724,27412],[55696,28496],[43976,24664]])
out=ROOT/'data/RaidBoss/c4_grand_bosses.json';out.parent.mkdir(parents=True,exist_ok=True)
out.write_text(json.dumps(bundle,ensure_ascii=False,indent=2)+'\n')
print('Imported',len(npcs),'NPCs,',len(items),'jewels,',len(ambient),'ambient spawns')
