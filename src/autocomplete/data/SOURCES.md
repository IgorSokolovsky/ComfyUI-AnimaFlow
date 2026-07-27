# Autocomplete data sources

Both bundled CSVs are tag-count snapshots from the
[`DraconicDragon/dbr-e621-lists-archive`](https://github.com/DraconicDragon/dbr-e621-lists-archive)
project and are released under the **Unlicense** (public domain). No
attribution is legally required, but it's noted here so provenance isn't
lost.

## `gelbooru.csv` — primary source

- URL: `https://raw.githubusercontent.com/DraconicDragon/dbr-e621-lists-archive/main/tag-lists/gelbooru/gelbooru_2026-06-10_pt20.csv`
- Snapshot date: 2026-06-10
- License: Unlicense (public domain)
- Format: no header row, 4 comma-separated columns per row:
  `tag,category_code,count,aliases` (`aliases` is often empty; when present
  it may itself contain commas and is then CSV-quoted).
- Category codes (verified against sample rows in this file):
  `0`=general, `1`=artist, `3`=copyright, `4`=character, `5`=meta.

## `danbooru.csv` — fallback source

- Copied from the already-cloned reference pack:
  `../ComfyUI-EasyUseAnima/__easyuse_anima__/danbooru_2025-09-01.csv`
  (same upstream project/snapshot family as the Gelbooru file above, so the
  format and category-code mapping are identical).
- Snapshot date: 2025-09-01
- License: Unlicense (public domain)
- Format: identical 4-column `tag,category_code,count,aliases` shape, same
  category-code mapping as `gelbooru.csv` (verified against sample rows,
  e.g. `hatsune_miku,4,...` = character, `dairi,1,...` = artist,
  `highres,5,...` = meta).
