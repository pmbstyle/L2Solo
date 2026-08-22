# Clan and alliance crest pack

The BMP files in this directory are normalized from the gallery at
<https://l2topzone.com/crests>.

- clan crests are 16×12 indexed BMP files;
- alliance crests are the right-hand 8×12 portion of the gallery's 24×12
  combined images;
- `manifest.json` records the source URL and SHA-256 for every imported file.

The importer is repeatable:

```powershell
python scripts/import-clan-crests.py --count 250
```
