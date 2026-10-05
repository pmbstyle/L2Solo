// Exercise the NPC's primary menu and only click links actually sent to C4.
const assert = require('node:assert/strict');
const { DataCache } = require('./c4QuestHarness');
const NpcTalk = invoke('GameServer/World/Generics/NpcTalk');
const NpcTalkResponse = invoke('GameServer/World/Generics/NpcTalkResponse');

async function settle(session) {
    await session.questMutationTail;
    await new Promise(resolve => setImmediate(resolve));
    await session.questMutationTail;
}

async function click(session, world, link) {
    assert(world.page(session).includes(`bypass -h ${link}"`), `NPC offers ${link}`);
    const before = session.packets.length;
    NpcTalkResponse(session, { link });
    await settle(session);
    assert(session.packets.slice(before).some(p => p[0] === 0x0f), `${link} produces an NPC HTML response`);
}

async function talk(session, world, template, personal = null) {
    const data = DataCache.npcs.find(n => n.selfId === template);
    assert(data, `NPC ${template} has a template`);
    const npc = personal || {
        fetchSelfId: () => template, fetchId: () => template + 400000,
        fetchName: () => data.template.name, fetchTitle: () => data.template.title,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
        isDead: () => false
    };
    const before = session.packets.length;
    NpcTalk(session, npc);
    await settle(session);
    assert(session.packets.slice(before).some(p => p[0] === 0x0f), `NPC ${template} opens a dialogue`);
    const menu = `html ${template}-quest`;
    if (world.page(session).includes(`bypass -h ${menu}"`)) await click(session, world, menu);
}

async function questClick(ctx, questId, event, template, personal = null) {
    const action = `quest ${questId} ${event}`;
    // Continue multi-page conversations (e.g. the First Orc's story) without
    // reopening the NPC and discarding its offered follow-up link.
    if (ctx.session.activeNpcTalk?.selfId === template
        && (!personal || ctx.session.activeNpcTalk.objectId === personal.fetchId())
        && ctx.world.page(ctx.session).includes(`bypass -h ${action}"`)) {
        return click(ctx.session, ctx.world, action);
    }
    await talk(ctx.session, ctx.world, template, personal);
    if (!ctx.world.page(ctx.session).includes(`bypass -h ${action}"`)) {
        await click(ctx.session, ctx.world, `quest ${questId} show_quest`);
    }
    await click(ctx.session, ctx.world, action);
}

module.exports = { talk, click, questClick, settle };
