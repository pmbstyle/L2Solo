// Reviewed gameplay facts: supplied inventory plus pinned MOBIUS_C4 6674a607.
// NPC IDs below are L2Solo's native datapack IDs. See docs/c4/quests/imported-quests.md.
const collect = (id, name, minLevel, startNpc, item, count, drops, reward, extra = {}) => ({
    id, name, minLevel, startNpc, repeatable: true, ...extra,
    stages: [{ type: 'KILL_COLLECT', item, count, drops: drops.map(([npc,chance,amounts]) => ({npc,chance,...(amounts ? {amounts} : {})})) },
        { type: 'COMPLETE', npc: startNpc, takes: [[item,count]] }], reward
});
const definitions = [
    {id:325,name:'Grim Collector',minLevel:15,startNpc:7336,quitNpc:7434,repeatable:true,
        questItems:Array.from({length:10},(_,i)=>1349+i),
        stages:[{type:'TALK',npc:7434,gives:[[1349,1]]},
            {type:'COLLECT',npc:7434,cashoutEvent:'sell_parts',quitPays:true,
                prices:[[1350,30],[1351,20],[1352,20],[1353,100],[1354,40],[1355,14],[1356,14],[1357,14],[1358,341]],
                bonusAt:11,bonusAdena:1629,ownedBonuses:[{item:1358,adena:543}],
                drops:[
                    [26,[[1350,30],[1351,50],[1352,75]]],[29,[[1350,30],[1351,52],[1352,75]]],
                    [35,[[1353,5],[1354,15],[1355,29],[1357,79]]],[42,[[1353,6],[1354,19],[1356,69],[1357,86]]],
                    [45,[[1353,9],[1355,59],[1356,77],[1357,97]]],[51,[[1353,9],[1354,59],[1355,79],[1356,100]]],
                    [457,[[1350,40],[1351,60],[1352,80]]],[458,[[1350,40],[1351,70],[1352,100]]],
                    [514,[[1353,6],[1354,21],[1355,30],[1356,31],[1357,64]]],
                    [515,[[1353,5],[1354,20],[1355,31],[1356,33],[1357,69]]]
                ].map(([npc,thresholds])=>({npc,chance:1,outcomes:thresholds.map(([item,percent],i)=>({item,chance:(percent-(thresholds[i-1]?.[1]||0))/100}))}))}],
        exchanges:[{npc:7342,event:'assemble',cond:2,label:'Assemble one skeleton (90% success)',
            takes:[[1353,1],[1354,1],[1355,1],[1356,1],[1357,1]],reward:{choices:[{weight:9,items:[[1358,1]]},{weight:1,items:[]}]}},
            {npc:7434,event:'sell_skeletons',cond:2,label:'Sell only complete skeletons',consumeAll:[1358],reward:{adena:543,perItemAdena:[[1358,341]]}}]},
    {id:292,name:'Brigands Sweep',minLevel:5,race:4,startNpc:7532,repeatable:true,questItems:[1483,1484,1485,1486,1487],
        stages:[false,true].map(hasContract=>({type:'COLLECT',npc:7532,prices:[[1483,12],[1484,36],[1485,33]],bonusAt:10,bonusAdena:1000,
            handInExtras:[{item:1487,adena:1120,next:1}],
            drops:[322,323,324,327,528].map(npc=>({npc,chance:1,outcomes:[
                {item:npc===323?1484:npc===528?1485:1483,chance:.4},...(!hasContract?[{item:1486,chance:.1}]:[])]})),
            ...(!hasContract?{transforms:[{from:1486,count:3,to:1487,consumeAll:true,next:2}]}:{})})),
        exchanges:[{npc:7533,event:'sell_contract',cond:2,next:1,label:'Sell the suspicious contract for 1500 Adena',takes:[[1487,1]],reward:{adena:1500}}]},
    // The reference registers a third target, Crimson Tarantula 20394 (native
    // 394), but the pinned C4 datapack never spawns it anywhere - its template
    // exists and no spawn file mentions it. The two targets below are therefore
    // all a C4 player can actually kill. See docs/c4/quests/imported-quests.md.
    {id:296,name:"Tarantula's Spider Silk",minLevel:15,startNpc:7519,repeatable:true,requiredAny:[1508,1509],
        stages:[{type:'COLLECT',npc:7519,prices:[[1493,20]],bonusAt:10,bonusAdena:2000,
            drops:[403,508].map(npc=>({npc,chance:1,outcomes:[{item:1494,chance:.04},{item:1493,chance:.5}]}))}],
        exchanges:[{npc:7548,event:'spin_silk',cond:1,label:'Extract silk from all spinnerettes',convertAll:{from:1494,to:1493,min:15,max:24}}]},
    {id:347,name:'Go Get the Calculator',minLevel:12,startNpc:7526,repeatable:true,
        stages:[
            {type:'CHOICE',choices:[{npc:7533,event:'balanki',label:'Pay 100 Adena for information',takes:[[57,100]],next:2},
                {npc:7532,event:'spiron',label:'Ask about the calculator',next:3}]},
            {type:'CHOICE',choices:[{npc:7532,event:'spiron',label:'Ask about the calculator',next:4}]},
            {type:'CHOICE',choices:[{npc:7533,event:'balanki',label:'Pay 100 Adena for information',takes:[[57,100]],next:4}]},
            {type:'TALK',npc:7527},
            {type:'KILL_COLLECT',item:4286,count:10,drops:[{npc:540,chance:.5}]},
            {type:'DELIVER',npc:7527,takes:[[4286,10]],gives:[[4285,1]]},
            {type:'CHOICE',choices:[{npc:7526,event:'keep_calculator',label:'Keep the calculator',takes:[[4285,1]],finish:true,reward:{items:[[4393,1]]}},
                {npc:7526,event:'sell_calculator',label:'Receive 1000 Adena',takes:[[4285,1]],finish:true,reward:{adena:1000}}]}
        ]},
    { id:259,name:"Rancher's Plea",minLevel:15,startNpc:7497,repeatable:true,
        stages:[{type:'COLLECT',npc:7497,prices:[[1495,25]],bonusAt:10,bonusAdena:250,
            drops:[103,106,108].map(npc=>({npc,item:1495,chance:1}))}],
        exchanges:[{event:'potion',npc:7405,cond:1,label:'Exchange ten skins for a healing potion',takes:[[1495,10]],gives:[[1061,1]]},
            {event:'arrows',npc:7405,cond:1,label:'Exchange ten skins for fifty wooden arrows',takes:[[1495,10]],gives:[[17,50]]}] },
    { id:316,name:'Destroy Plague Carriers',minLevel:18,race:1,startNpc:7155,repeatable:true,
        stages:[{type:'COLLECT',npc:7155,prices:[[1042,30],[1043,10000]],bonusAt:10,bonusItems:[1042],bonusAdena:5000,
            drops:[{npc:40,item:1042,chance:.4},{npc:47,item:1042,chance:.4},{npc:5020,item:1043,chance:.2,cap:1}]}] },
    { id:274,name:'Skirmish with the Werewolves',minLevel:9,race:3,startNpc:7569,repeatable:true,requiredAny:[1506,1507],
        stages:[{type:'KILL_COLLECT',item:1477,count:40,drops:[363,364].map(npc=>({npc,chance:1})),sideDrops:[{item:1501,chance:.06}]},
            {type:'COMPLETE',npc:7569,takes:[[1477,40]],consumeAll:[1501]}],reward:{adena:3500,perItemAdena:[[1501,600]]} },
    // Harlan's wine. The reference rolls getRandom(10): under 3 the fifteen-year
    // wine, under 9 the thirty-year, otherwise the sixty-year. The weights below
    // are that same ten-part split. Its templates are now authored, so the
    // MISSING_ITEM_TEMPLATES block is lifted.
    { id:379,name:'Fantasy Wine',minLevel:20,startNpc:7074,repeatable:true,
        stages:[{type:'KILL_COLLECT',objectives:[[5893,80],[5894,100]],drops:[{npc:291,item:5893,chance:1},{npc:292,item:5894,chance:1}]},
            {type:'COMPLETE',npc:7074,takes:[[5893,80],[5894,100]]}],
        reward:{choices:[{weight:3,items:[[5956,1]]},{weight:6,items:[[5957,1]]},{weight:1,items:[[5958,1]]}]} },
    // Swan's mandolin. A pure talk chain: Woodrow names Galion, Galion hands over
    // the flute, Swan adds his letter, Nanarin takes both, and Swan pays. The
    // reference exits repeatable, so the errand can be run again.
    { id:362,name:"Bard's Mandolin",minLevel:15,startNpc:7957,repeatable:true,questItems:[4316,4317],
        stages:[{type:'TALK',npc:7837},
            {type:'TALK',npc:7958,gives:[[4316,1]]},
            {type:'TALK',npc:7957,gives:[[4317,1]]},
            {type:'TALK',npc:7956,takes:[[4316,1],[4317,1]]},
            {type:'COMPLETE',npc:7957}],
        reward:{adena:10000,items:[[4410,1]]} },
    // Pixy Murika's fangs. Each target has its own chance and its own amount:
    // the grey wolf always yields two or three, the elder keltir always two, the
    // young red keltir one at 80%, and the red keltir at 60% yields one on a
    // getRandom(3) of zero and two otherwise. The reward is the reference's own
    // getRandom(100) split: under 10 the emerald, under 30 the blue onyx, under
    // 60 the onyx, otherwise a glass shard.
    { id:266,name:'Pleas of Pixies',minLevel:3,race:1,startNpc:12091,repeatable:true,
        stages:[{type:'KILL_COLLECT',item:1334,count:100,drops:[
                {npc:525,chance:1,amounts:[{amount:2,chance:.5},{amount:3,chance:.5}]},
                {npc:537,chance:1,amount:2},
                {npc:530,chance:.8,amount:1},
                {npc:534,chance:.6,amounts:[{amount:1,chance:1/3},{amount:2,chance:2/3}]}]},
            {type:'COMPLETE',npc:12091,takes:[[1334,100]]}],
        reward:{choices:[{weight:10,items:[[1337,1]]},{weight:20,items:[[1338,1]]},
            {weight:30,items:[[1339,1]]},{weight:40,items:[[1336,1]]}]} },
    { id:263,name:'Orc Subjugation',minLevel:8,race:2,startNpc:7346,repeatable:true,
        stages:[{type:'COLLECT',npc:7346,prices:[[1116,20],[1117,30]],bonusAt:10,bonusAdena:1000,
            drops:[385,386,387,388].map(npc=>({npc,item:npc===385?1116:1117,chance:.5}))}] },
    // Every variant pair drops its own shard at its own chance: the plain
    // salamander and undine at 30%, the elders at 40% and the nobles at 50%.
    // The elders and nobles are now spawned from the reference's own 21_25
    // points, so all six targets are reachable.
    { id:306,name:'Crystals of Fire and Ice',minLevel:17,startNpc:7004,repeatable:true,
        stages:[{type:'COLLECT',npc:7004,prices:[[1020,60],[1021,60]],bonusAt:10,bonusAdena:5000,
            drops:[[109,1020,.3],[110,1021,.3],[112,1020,.4],[113,1021,.4],[114,1020,.5],[115,1021,.5]]
                .map(([npc,item,chance])=>({npc,item,chance}))}] },
    { id:317,name:'Catch the Wind',minLevel:18,startNpc:7361,repeatable:true,
        stages:[{type:'COLLECT',npc:7361,prices:[[1078,40]],bonusAt:10,bonusAdena:2988,
            drops:[36,44].map(npc=>({npc,item:1078,chance:.5}))}] },
    collect(261, "Collector's Dream", 15, 7222, 1087, 8, [[308,1],[460,1],[466,1]], {adena:1000,exp:2000}),
    collect(262, 'Trade with the Ivory Tower', 8, 7137, 707, 10, [[400,.4],[7,.3]], {adena:3000}),
    collect(272, 'Wrath of Ancestors', 5, 7572, 1474, 50, [[319,1],[320,1]], {adena:1500}, {race:3}),
    collect(291, 'Revenge of the Redbonnet', 4, 7553, 1482, 40, [[317,1]], {
        choices:[{weight:3,items:[[1502,1]]},{weight:18,items:[[1503,1]]},
            {weight:25,items:[[1504,1]]},{weight:54,items:[[1505,1],[736,1]]}]
    }),
    collect(294, 'Covert Business', 10, 7534, 1491, 100, [
        [370,1,[{amount:2,chance:.3},{amount:3,chance:.2},{amount:4,chance:.2},{amount:1,chance:.3}]],
        [480,1,[{amount:2,chance:.3},{amount:3,chance:.3},{amount:1,chance:.4}]]
    ], {sp:600,ifOwned:{item:1508,yes:{adena:2400},no:{items:[[1508,1]]}}}, {race:4}),
    collect(258, 'Bring Wolf Pelts', 3, 7001, 702, 40, [[120,1],[442,1]], {
        choices: [[1,390],[5,29],[3,22],[4,1119],[3,426]].map(([weight,id]) => ({weight,items:[[id,1]]}))
    }),
    collect(264, 'Keen Claws', 3, 7136, 1367, 50, [
        [3,1,[{amount:2,chance:.5},{amount:4,chance:.5}]], [456,1,[{amount:1,chance:.5},{amount:2,chance:.5}]]
    ], { choices: [{weight:1,items:[[43,1]]},{weight:1,adena:1000},{weight:3,items:[[36,1]]},
        {weight:3,items:[[462,1]],adena:50},{weight:3,items:[[1061,1]]},{weight:3,items:[[48,1]]},{weight:3,items:[[35,1]]}] }),
    collect(271, 'Proof of Valor', 4, 7577, 1473, 50, [[475,1,[{amount:2,chance:.25},{amount:1,chance:.75}]]],
        {choices:[{weight:1,items:[[1507,1]]},{weight:9,items:[[1506,1]]}]}, {race:3}),
    collect(277, "Gatekeeper's Offering", 15, 7576, 1572, 20, [[333,.5]], {items:[[1658,2]]}),
    collect(295, 'Dreaming of the Skies', 11, 7536, 1492, 50, [[153,1,[{amount:1,chance:.74},{amount:2,chance:.26}]]],
        {sp:500,ifOwned:{item:1509,yes:{adena:2400},no:{items:[[1509,1]]}}}),
    collect(297, "Gatekeeper's Favor", 15, 7540, 1573, 20, [[521,.5]], {items:[[1659,2]]}),
    collect(303, 'Collect Arrowheads', 10, 7029, 963, 10, [[361,.4]], {adena:1000,exp:2000}),
    collect(313, 'Collect Spores', 8, 7150, 1118, 10, [[509,.4]], {adena:3500}),
    collect(319, 'Scent of Death', 11, 7138, 1045, 5, [[15,.2],[20,.2]], {adena:3350,items:[[1060,1]]}),
    collect(320, 'Bones Tell the Future', 10, 7359, 809, 10, [[517,.18],[518,.2]], {adena:8470}, {race:2}),
    collect(324, 'Sweetest Venom', 18, 7351, 1077, 10, [[34,.22],[38,.23],[43,.25]], {adena:5810}),
    collect(341, 'Hunting for Wild Beasts', 20, 7078, 4259, 20, [[21,.5],[203,.9],[310,.5],[335,.7]], {adena:3710})
];
module.exports = definitions;
