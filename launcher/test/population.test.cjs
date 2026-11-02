'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { population } = require('../../scripts/launcher-population');
const { isRealPlayerSession } = require('../../src/GameServer/Bot/Population/PlayerActivitySignal');
const { Controller, loginConnection } = require('../main/controller.cjs');
const identityContext = { module: {exports:{}}, invoke: () => ({ PermanentTrader: {} }) };
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../src/GameServer/Bot/AI/BotServiceIdentity.js'), 'utf8'), identityContext);
const { isStaticService } = identityContext.module.exports;
const actor = id => ({ fetchId: () => id, fetchIsOnline: () => true });

test('launcher population counts all dynamic bots once, with real players and without static services', () => {
    const result = population({
        states: [ {characterId:1,phase:'hot'}, {characterId:2,phase:'cold'}, {characterId:3,phase:'warm'},
            {characterId:4,staticService:true}, {characterId:5,stats:{craftStationId:1}},
            {characterId:6,name:'PermanentTrader'}, {characterId:7,plan:'merchant',coldMarketState:{}} ],
        botSessions: [ {actor:actor(1)}, {actor:actor(4)}, {actor:actor(8),partyCompanion:true}, {actor:actor(9),plan:'merchant'} ],
        playerSessions: [ {accountId:'player',actor:actor(10)}, {accountId:'bot_fake',actor:actor(11)},
            {accountId:'connecting'}, {accountId:'offline',actor:{fetchIsOnline:()=>false}},
            {accountId:'simulated',actor:actor(12),isSimPlayer:true} ],
        isStaticService, isRealPlayerSession, botCapacity: 10
    });
    assert.deepEqual(result, {bots:5,players:1,capacity:10});
    assert.deepEqual(population({states:[],botSessions:[],playerSessions:[],isStaticService,isRealPlayerSession,botCapacity:0}), {bots:0,players:0,capacity:0});
    assert.equal(population({ states:Array.from({length:2205}, (_,i)=>({characterId:i+1})), botSessions:[],playerSessions:[],
        isStaticService,isRealPlayerSession,botCapacity:2500 }).bots, 2205);
});

test('login address uses the advertised host and auth port, with concrete listen and LAN fallbacks', () => {
    const interfaces = {lo:[{family:'IPv4',address:'127.0.0.1',internal:true}],en0:[{family:'IPv4',address:'192.168.1.20',internal:false}]};
    assert.equal(loginConnection({GameServer:{advertisedHostname:'100.92.15.42'},AuthServer:{hostname:'0.0.0.0',port:'2107'}},interfaces).address, '100.92.15.42:2107');
    assert.equal(loginConnection({AuthServer:{hostname:'127.0.0.1'}},interfaces).address, '127.0.0.1:2106');
    assert.equal(loginConnection({AuthServer:{hostname:'0.0.0.0'}},interfaces).address, '192.168.1.20:2106');
    assert.equal(loginConnection({},{}).address, '127.0.0.1:2106');
    assert.equal(loginConnection({AuthServer:{hostname:'::1'}},{}).address, '[::1]:2106');
});

test('real server wrapper relays live population into the desktop controller and clears it on stop', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-population-relay-'));
    const root = path.join(directory,'server');
    const put = (name,content) => {const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);};
    put('package.json','{"version":"0.1.0"}');
    put('config/default.ini','[Database]\npath=tmp/world.sqlite\n[AuthServer]\nhostname=127.0.0.1\nport=2107\n[GameServer]\nadvertisedHostname=100.92.15.42\n');
    put('scripts/run-server.js',fs.readFileSync(path.resolve(__dirname,'../../scripts/run-server.js')));
    put('scripts/geodata-release.json','{}');
    put('scripts/geodata-bootstrap.js',`module.exports={async inspectDirectory(){return {valid:true}},async ensureGeodata(){return {directory:__dirname,usageFile:'fixture'}},releaseGeodataUsage(){},async transferGeodataUsage(){}};`);
    put('scripts/run-game-server.js',`process.on('message',m=>{if(m.type==='shutdown')process.exit(0);if(m.type==='geodata_ready'){console.log('GameServer :: successful init');process.send({type:'launcher:population',bots:-1,players:0,capacity:15});setTimeout(()=>process.send({type:'launcher:population',bots:5,players:1,capacity:15}),40);}});`);
    const controller = new Controller({userData:path.join(directory,'profile'),nodePath:process.execPath});
    try {
        await controller.choose(root);
        await controller.start();
        const deadline = Date.now()+5000;
        while (!controller.state.population) {
            if(Date.now()>deadline)throw new Error('Population did not reach the desktop controller.');
            await new Promise(resolve=>setTimeout(resolve,20));
        }
        assert.deepEqual({...controller.state.population,updatedAt:0},{bots:5,players:1,total:6,capacity:15,updatedAt:0});
        assert.equal(controller.state.connection.address,'100.92.15.42:2107');
        controller.child.emit('message', {type:'launcher:population',bots:0,players:1,capacity:0});
        assert.equal(controller.state.population.capacity,0, 'a disabled bot target must stay zero in the launcher');
        await controller.stop();
        assert.equal(controller.state.population,null);
    } finally {await controller.stop();fs.rmSync(directory,{recursive:true,force:true});}
});
