<img alt="LineageII Solo" src="https://github.com/user-attachments/assets/a78e7191-80a1-4411-937e-e5e7de69ff4b" />



# L2Solo (C4: Scions of Destiny)

Old-school Lineage 2 solo play, locally in a live world with over 1500 population.

L2Solo is a local-first Lineage II C4 server emulator, tuned for a solo MMO experiment: one real player, a live world, and SimPlayers with AI that make the server feel alive.

<p align="center">🏗️ Work in progress. Playable.</p>

## Game Checklist

### Playable Now

✅ Authentication (C4 client, protocol 656)

✅ Controllable progression rate on server start (x1/x10/x50) Xp, Sp, party XP/SP, drop/adena/spoil/quest multipliers

✅ Player character, inventory, skills, shortcuts, position, and progression

✅ Mob fight, damage, death, respawn

✅ All C4 skills, including mob skills, potions, scrolls, spoil, SA, manor, etc

✅ Drop pickup, item use, equip and unequip gear, soulshots, heal potions, etc

✅ Buy and sell through NPC shops with city and NPC-specific assortments, prices, and Giran luxury exchanges

✅ SimPlayers population that hunts, rests, flees, revives, shops, restocks, loots, chatters, and reacts to nearby player chat

✅ Trade with buing/selling Simplayers

✅ Find SimPlayers with `.botparty`, invite nearby candidates, and manage accepted companions through the in-game companion panel

✅ Inspect companion, social memory, and bot state through `.botstatus`

✅ Trade directly with targeted SimPlayers through the native trade window (/trade)

✅ See companion bots ask for useful non-junk drops, then satisfy the request by handing the item over through the real trade flow

✅ SimPlayers role-aware in party: tanks protect/pull cautiously, healers conserve MP and heal, buffers refresh support buffs, daggers close-assist, and ranged roles assist at range

✅ Early PK-style bot behavior: hostile hunting, fleeing, and nearby bot reactions

✅ Early SimPlayer social memory: bots remember invite/group/dismiss interactions and expose relationship/trust in status surfaces

✅ First loot-etiquette loop: party members can request useful drops, fulfilled trades update social memory, and ignored active requests are remembered lightly

✅ Local admin tools for teleporting, item grants, random teleport, and Adena

✅ Optional AI bot brain is available for player-visible moments, but still needs more personality tuning


### In Progress


✴️ More natural long-term SimPlayer memory: level history, wipes, insults, deeper relationships, and personal routines should persist instead of feeling reset between sessions

✴️ Bot progression that feels earned: levels, gear, and class growth should come from real activity, not from hidden scaling

✴️ More believable economy loops: local buyers, sellers, stock pressure, restocking, and player-visible trade behavior

✴️ More social chatter that sounds like players talking about the world, drops, prices, spots, danger, and plans

✴️ Better AI brain: social connections (friends/enemies), memory, chat, etc

### Planned

#️⃣ All NPC quests, all dialogues

#️⃣ More complete towns, hunting routes, respawn behavior, and regional difficulty curves

#️⃣ Crafting, enchanting, warehouse, freight, and deeper item economy systems

#️⃣ Clan/social systems and longer-term player identity

#️⃣ Clan halls, sieges, raid bosses, world bosses 

#️⃣ Easy install for non-tech fellows (install and play)

#️⃣ Complete Lineage 2 C4 experience

## Requirements

- Node.js LTS
- Docker, unless you run MariaDB yourself
- A Lineage II C4 client using protocol 656

Client reference: use a clean Lineage II C4 client matching protocol 656.

## Quick Start

```bash
npm start
```

That command will:

- open the local launcher at `http://127.0.0.1:8090/`;
- show the current server state;
- start and stop the server from the launcher;
- open the world observer map when the server is running.

The launcher keeps the latest server session log at `tmp/logs/latest-server.log` and rotates the prior one to `tmp/logs/previous-server.log`.

Press `Start` in the launcher to run the normal server bootstrap. That start action will:

- install Node dependencies if `node_modules` is missing;
- create or start a local `nodel2-mariadb` Docker container when the configured database host is `127.0.0.1` or `localhost`;
- import `database/sql/database.sql` on first boot if database `nodel2` does not exist;
- start the auth server on `2106`, the game server on `7777`, and the world observer on `8088`.

If you run MariaDB yourself, set:

```bash
L2NODE_SKIP_DOCKER=1 npm start
```

The old direct server command still works:

```bash
npm run NodeL2
```

Use it when dependencies and the database are already prepared, and you want no bootstrap behavior.

## Configuration

Committed defaults live in `config/default.ini`.

Private local overrides go in ignored `config/local.ini`. This is where API keys and machine-specific database settings belong.

Example:

```ini
[OpenRouter]
enabled = true
apiKey = sk-or-v1-your-key-here
model = google/gemini-2.5-flash-lite
debug = true
```

If you use your own database instead of the local Docker container, override the `Database` section there as well.

OpenRouter can also read the key/model from environment variables:

```bash
OPENROUTER_API_KEY=sk-or-v1-your-key-here npm start
```

Useful startup variables:

- `L2NODE_SKIP_DOCKER=1` - skip Docker bootstrap and use the configured database.
- `L2NODE_DB_CONTAINER=some-name` - override the Docker container name.
- `L2NODE_DB_IMAGE=mariadb:10.6` - override the MariaDB image.
- `BOT_STATUS_LOGS=0` - disable periodic bot status log lines.

## In-Game Commands

- `.admin` - open the admin menu.
- `.sell` - sell all unequipped non-Adena items for 50% item value.
- `.bot` or `.companion` - open the companion control panel.
- `.botstatus` - show a bot overview panel.
- `.botstatus <name>` - show detailed status for a specific bot.
- `.botpath` / `.botpath <name>` - inspect bot movement, town-route waypoints, and geodata path diagnostics.
- `.trade` or `/trade` - open the bot trade window with the targeted SimPlayer, useful as a fallback to the native client trade action.
- `.leave` - dismiss all companion bots.
- `.kick <name>` - dismiss one companion bot.
- `/invite` while targeting a bot - recruit that bot as a companion.
- `/dismiss <name>` and `/leave` also work through the party request path.

Nearby bots also react to plain chat lines such as `hi`, `follow`, `wait`, `hunt`, `heal`, and `buff`. Healing and buff help depends on the bot's class and current plan.

## Bot Systems

SimPlayers are normal server sessions backed by database characters. On startup, `BotManager` loads them, assigns plans, and ticks their behavior.

Main bot modes:

- `hunting` - find monsters, fight, loot, and move between spots.
- `resting` - recover HP/MP.
- `getting_buffed` - visit newbie buff flow when low-level buffs expire.
- `shopping` - return to town, sell junk, and restock consumables.
- `following` - assist a real player as a companion.
- `merchant` - stand in town with private buy/sell store state.
- `pk_hunting` / `pk_fleeing` - hostile player-killer loop and safety recovery.

Companion behavior is role-aware. `BotRoles` infers healer, buffer, tank, dagger, archer, mage, or generic DPS from class id. In party mode, tanks can protect the leader and avoid unsafe pulls, healers heal while conserving MP, buffers apply `Might`, `Shield`, `Haste`, and `Wind Walk`, daggers close-assist, and ranged roles keep ranged assist intent.

Bot status is meant to be inspectable. Use `.botparty` to find available nearby SimPlayers, `.botstatus` for state, social memory, role decisions, buff timers, and loot requests, `.botpath` for movement and town-route diagnostics, companion panel `Status` links, or watch `BotStatus :: ...`, `BotSocial :: ...`, `BotRole :: ...`, and `BotLoot :: ...` lines in the server logs.

To reset generated SimPlayer accounts and characters while keeping the rest of the database intact:

```bash
npm run wipe:bots
```

## Merchant Bots

Merchant bots currently cover:

- Talking Island: starter materials, starter gear, and island-drop buyers.
- Gludio: D-grade materials, gear, and plains-drop buyers.
- Dion: C-grade crafting stock, parts, and Dion-drop buyers.
- Giran: C/B-grade materials, gear, and Giran-drop buyers.
- Oren: B/A-grade materials, gear, and Oren-drop buyers.

## Bot Trade and Loot Etiquette

Player-to-bot trade uses the normal client trade flow. Target a SimPlayer and use the native trade action, or type `.trade` / `/trade` while testing. The server opens the trade window, accepts offered items, moves them into the bot inventory, and records the interaction in social memory.

Grouped companion bots also watch notable drops. They ignore Adena and obvious junk, score item usefulness by role, throttle requests, and ask only when a nearby companion has a reason to want the item. If the player trades the requested item to that bot before the request expires, the handoff records `gave_useful_loot`; ignored requests are only remembered when the bot is still an active nearby companion.

Dwarven Spoil/Sweeper uses the normal skill flow. Use `Spoil` on a living monster with spoil-table rewards, kill it, then use `Sweeper` on the sweepable corpse before it decays. Spoil rewards are rolled from `data/Npcs/Rewards/rewards.json` and are added to the player's inventory.


## AI Bot Brain

The deterministic server code still owns combat, movement, inventory, shopping, and safety. The optional LLM brain is only allowed to influence small, whitelisted decisions.

Important behavior:

- Disabled by default.
- Requires `OpenRouter.enabled = true` plus an API key.
- Only considers bots visible to a real online player.
- Skips merchant plans and missing-player contexts.
- Emits debug skip reasons when `OpenRouter.debug = true`.

This keeps token spend tied to player-visible moments instead of letting offline bots burn calls in an empty world.

## Development

Run the focused tests:

```bash
node tests/test_pathfinder_astar.js
node tests/test_path_obstacle.js
```

Run a full boot check:

```bash
npm start
```

Then press `Start` in the launcher.

Expected healthy boot signs:

- `DB :: connected`
- `Datapack :: cached`
- `SpawnsGrid :: Indexed ... npcs in 2D spatial grid`
- `AuthServer :: successful init for 0.0.0.0:2106`
- `GameServer :: successful init for 0.0.0.0:7777`
- `BotManager :: ... is active in World`
- `BotStatus :: ...`, `BotRole :: ...`, `BotLoot :: ...`, or `BotSocial :: ...` when the corresponding bot paths are active

## Credits

This project is a heavily modified solo-MMO fork of the original [NodeL2 Server Emulator](https://github.com/NodeL2/NodeL2).

L2Solo is licensed under the Apache 2.0 license.

Crafting with ❤️ by a player for players 🤘
