# Roon Browse API - Research Findings

## Goal
Get artist bios/descriptions from Roon for display in the GNOME extension.

## Public Browse API (node-roon-api-browse)
- Service: `com.roonlabs.browse:1`
- Methods: `browse(opts, cb)` and `load(opts, cb)`
- Both pass opts directly to `core.moo.send_request()`
- Hierarchies: browse, search, playlists, settings, internet_radio, albums, artists, genres, composers
- **Does NOT return artist bios** through public API
- Artist page via search only shows: "Play Artist" → Shuffle / Start Radio
- List metadata includes: `title`, `subtitle`, `image_key`, `count`, `level`, `hint`
- Item metadata includes: `title`, `subtitle`, `image_key`, `item_key`, `hint`, `input_prompt`

## Internal Protocol (from Wireshark capture of Mac Roon client)

### Bookmark/Navigation Format
The native Roon client uses a different navigation model than the extension API:
```json
{
  "mode": "<random-uuid-per-session>",
  "type": "artistdetails",
  "name": "artist name",
  "data": {
    "performer_id": "<base64-encoded-opaque-blob>"
  }
}
```

### Supported internal types
- `artistdetails` - data: `{ performer_id: "<base64>" }`
- `albumdetails` - data: `{ album_id: "<base64>" }`
- `playlistdetails` - data: `{ playlist_id: "<base64>", focus: {...} }`
- `unifiedsearch` - data: `{ terms: "search query" }`

### performer_id Format
- Base64-encoded binary blob
- Contains a shared prefix (core/database identity)
- Embeds AllMusic-style identifiers like `MN0000851972`, `MN0000609636`
- Also contains numeric IDs: `35195590`, `1078781`, `588480` etc.
- Example for artist "tips":
  `AQEBkyVj6l1FuEC60cAjE64grf////8FAAAADgAAAHoATU4wMDAwODUxOTcyEgAAAF4BPauNTId7rkSuyJtkX2s+LQkAAACnADM1MTk1OTAJAAAAyQAxMDc4NzgxCAAAAL8ANTg4NDgw`
- NOT the same as the browse API's `item_key` (which is simple like "1:0", "2:0")

### Biography Data Sources (found in capture)
- `Rovi-artists` / `Rovi-artists:en` - TiVo artist biographies
- `Wikipedia` / `Wikipedia:en` - Wikipedia articles
- `Rovi-albums` / `Rovi-albums:en` - Album reviews
- `Rovi-compositions` - Composition synopses
- Internal field name: `biography`
- Contains inline links: `[Artist Name](numericId)` and `[[numericId|Display Name]]`

### Key Discovery: `hierarchy` field NOT used by native client
The native Mac/iOS Roon client does NOT use the `hierarchy` parameter at all.
The `hierarchy` field is an abstraction added by the node.js extension API.
Native clients use the `mode`/`type`/`data` bookmark system instead.

## Test Script Results (bridge/test-artist-details.cjs)

### What worked
1. Public browse: search → categories → artist → actions (Shuffle, Start Radio)
2. `artist_image_keys` available from transport subscription (e.g., `4b70c574928cb36dbdcc1cc01a3adf33`)
3. `list.image_key` returned when navigating to artist page

### What didn't work
1. Adding `type`/`data` fields to a browse() call with `hierarchy` → fields ignored, treated as normal browse
2. Sending `type`/`data` without `hierarchy` → "JSON: missing required string field: hierarchy"
3. Using browse `item_key` as `performer_id` → wrong format (item_key="2:0" vs base64 blob)

## Final Conclusion: Browse API Does NOT Expose Artist Bios

Tested ALL paths exhaustively (test-artist-page.cjs, test-artist-details.cjs):

### What the Browse API returns for an artist (e.g., Adele with 3 local albums):
- `list.title` = "Adele", `list.subtitle` = "3 Albums", `list.image_key` = artist photo
- Items: "Play Artist" (→ Shuffle, Start Radio) + album list (→ tracks)
- That's ALL. No bio, no "About", no "Similar Artists", no "Top Tracks".

### What DOESN'T work:
1. Adding `type`/`data`/`mode` fields to browse requests → completely ignored
2. Using performer_id (base64) as `item_key` → InvalidItemKey
3. Using performer_id as `input` → treated as literal search string
4. `multi_session_key` with internal format → ignored
5. All 3 hierarchies (`search`, `browse`, `artists`) return the same limited structure

### The internal Sooloos.Broker.Api protocol (seen in Wireshark)
- Uses `artistdetails` type with base64-encoded performer_id
- Returns rich data: biography (Rovi/TiVo + Wikipedia), related artists, etc.
- This protocol is NOT accessible through the Extension Browse API
- It's a completely separate protocol layer for native Roon clients

### Alternative: External APIs for Artist Bios
Since Roon's Browse API won't give us bios, options:
1. **Last.fm API** - `artist.getInfo` returns biography text, free API key
2. **MusicBrainz + Wikipedia** - Get MusicBrainz artist ID → linked Wikipedia article
3. **Discogs API** - Artist profiles with bio text
4. All need artist name matching (which we have from now_playing)

## Undocumented Transport Events (from display_ui.js in Mac app bundle)
- `WaveformChanged` - array of floats (0-1), amplitude for whole track
- `LyricsChanged` - LRC format lyrics
- `artist_image_keys` - array of image keys for artist photo slideshow
- All available via standard transport zone subscription
