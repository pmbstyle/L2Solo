<img  alt="Lineage2 C2 Solo" src="https://github.com/user-attachments/assets/99b34112-87c3-40c9-97eb-e82cb3864c3d" />



# Lineage2 Solo (Chronicle 2)

Old-school Lineage 2 C2, but play solo, locally in a live world!

L2Solo is a local-first Lineage II Chronicle 2 server emulator tuned for a solo MMO experiment: one real player, a live world, and SimPlayer bots that make the server feel populated.

It is not trying to be a retail-complete private server. The current focus is bot behavior, party companions, town trade loops, and observability while keeping the server easy to run locally.

## Game Checklist

L2Solo is judged by what the world feels like in the client, not by how many server subsystems exist under the hood.

### Playable Now

- [x] Log in with a Chronicle 2 client and enter the world locally.
- [x] Create and persist characters, inventory, skills, shortcuts, position, and basic progression.
- [x] Move through the world, target NPCs, fight monsters, take damage, die, revive, and continue playing.
- [x] Pick up drops, use basic items, equip and unequip gear, use soulshots, and sell junk with `.sell`.
- [x] Buy and sell through NPC shops.
- [x] Explore populated starter areas with persistent SimPlayer characters instead of bots teleporting around the player.
- [x] See race-appropriate starter populations around each available race start, with a small number of visitor characters for MMO flavor.
- [x] Meet SimPlayers that hunt, rest, flee, revive, shop, restock, loot, chatter, and react to nearby player chat.
- [x] Find available SimPlayers with `.botparty`, invite nearby candidates, and manage accepted companions through the in-game companion panel.
- [x] Inspect companion, social memory, and bot state through `.botstatus`, companion `Status` links, and server-side status logs.
- [x] Encounter merchant SimPlayers in Talking Island, Gludio, Dion, Giran, and Oren with private buy/sell stores and occasional trade-chat ads.
- [x] See early PK-style bot behavior: hostile hunting, fleeing, and nearby bot reactions.
- [x] Use local admin tools for teleporting, item grants, random teleport, and Adena while testing.

### In Progress

- [x] Early SimPlayer social memory: bots remember invite/group/dismiss interactions and expose relationship/trust in status surfaces.
- [ ] More natural long-term SimPlayer memory: level history, loot etiquette, relationships, and personal routines should persist instead of feeling reset between sessions.
- [ ] Better starter-zone ecology: race-specific bot ratios, class mix, routes, and town/field behavior need more tuning by location.
- [ ] Bot progression that feels earned: levels, gear, and class growth should come from real activity, not from hidden scaling.
- [ ] Richer party play: clearer roles, smarter assist behavior, healing/buff timing, looting rules, and travel together.
- [ ] More believable economy loops: local buyers, sellers, stock pressure, restocking, and player-visible trade behavior.
- [ ] More social chatter that sounds like players talking about the world, drops, prices, spots, danger, and plans.
- [ ] Optional OpenRouter-backed bot brain for player-visible moments without spending tokens on background simulation.

### Planned

- [ ] Quest progression that matters for a solo MMO run.
- [ ] Broader class/skill coverage and better retail-like combat edge cases.
- [ ] More complete towns, hunting routes, respawn behavior, and regional difficulty curves.
- [ ] Crafting, enchanting, warehouse, freight, and deeper item economy systems.
- [ ] Clan/social systems and longer-term player identity.
- [ ] Safer public-server hardening. Right now this is a local development shard, not a production private server.

### Known Rough Edges

- Some geodata regions may be missing locally; the server falls back and logs warnings.
- C2 client packet compatibility is fragile. Store presentation, party UI, and unusual packet changes need live client testing.
- The database bootstrap preserves existing data by default. Resets are explicit.

## Requirements

- Node.js LTS.
- Docker, unless you run MariaDB yourself.
- A Lineage II C2 Splendor client using protocol 485.

Client reference: [LINEAGE II C2 Splendor Client](https://drive.google.com/file/d/1NVA4XY3bC2xD_Jejggo_b0fuMFChsZqe/view?usp=sharing)

## Quick Start

```bash
npm start
```

That command will:

- install Node dependencies if `node_modules` is missing;
- create or start a local `nodel2-mariadb` Docker container when the configured database host is `127.0.0.1` or `localhost`;
- import `database/sql/database.sql` on first boot if database `nodel2` does not exist;
- start the auth server on `2106` and the game server on `7777`.

If you run MariaDB yourself, set:

```bash
L2NODE_SKIP_DOCKER=1 npm start
```

The old direct server command still works:

```bash
npm run NodeL2
```

Use it when dependencies and database are already prepared and you want no bootstrap behavior.

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

Bot status is meant to be inspectable. Use `.botparty` to find available nearby SimPlayers, `.botstatus` for state and social memory, companion panel `Status` links, or watch `BotStatus :: ...` and `BotSocial :: ...` lines in the server logs.

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

The source of truth for town merchant stock is `src/GameServer/Bot/MerchantStoreConfigs.js`.

## OpenRouter Bot Brain

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

Expected healthy boot signs:

- `DB :: connected`
- `Datapack :: cached`
- `SpawnsGrid :: Indexed ... npcs in 2D spatial grid`
- `AuthServer :: successful init for 0.0.0.0:2106`
- `GameServer :: successful init for 0.0.0.0:7777`
- `BotManager :: ... is active in World`

## Credits

This project is a heavily modified solo-MMO fork of the original [NodeL2 Server Emulator](https://github.com/NodeL2/NodeL2).

L2Solo is licensed under the Apache 2.0 license.
