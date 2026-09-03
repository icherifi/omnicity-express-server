# blender-bridge

FastAPI service that runs on the VM with Blender installed. It receives commands
from the Express server's staging orchestrator (`src/services/blenderBridgeService.ts`
and `src/services/stagingOrchestratorService.ts`) and executes them against a
headless Blender process. It holds no business logic of its own — Claude decides
what to place/replace/paint, this service just executes bpy scripts.

Furniture comes live from IKEA's catalog via `ikea_lib.py`, vendored from
[shish/blender-ikea-browser](https://github.com/shish/blender-ikea-browser) (the
Blender addon this project's author pointed at). That file is plain stdlib
Python with **no `bpy` dependency** — it talks to ikea.com's internal (undocumented)
search/product/model APIs directly. Only the actual scene import
(`bpy.ops.import_scene.gltf`) needs Blender.

## ⚠️ Read before using this in anything commercial

`ikea_lib.py`'s own upstream README says: *"IKEA still owns the copyright for
these models, you probably don't want to be using them commercially, I guess?"*
This pipeline's stated purpose is real-estate staging renders meant to make a
room "donne envie d'acheter" — that's a commercial use of IKEA's copyrighted 3D
models. This is not something to route around technically; it's a decision for
whoever owns this project to make explicitly (get IKEA's sign-off, restrict
output to internal mockups/inspiration only, or switch to a licensed asset
library) before shipping staged renders to end users or clients.

Also note: `ikea_lib.py` is GPL-3.0-or-later (see the header comment in the
file). Fine for internal use; if this bridge is ever distributed, that file's
license terms apply to it.

## How a staging run flows

1. `POST /inspect {usdz_url}` — downloads the USDZ, imports it into a fresh Blender
   scene, classifies objects into walls/floor/ceiling vs. furniture by name
   (see the `*_KEYWORDS` heuristics in `main.py`), saves the scene as
   `sessions/<session_id>/working.blend`, and returns the room geometry as JSON.
2. `GET /ikea/search?q=...` / `GET /ikea/product/{item_no}` — live search and
   product lookup against ikea.com, no Blender involved (fast).
3. `POST /ikea/import` — downloads (and caches) an item's GLB model, optionally
   deletes a detected object first (replace), imports it into the session's
   `working.blend` at the given position/rotation, tags it with an `ikeaItemNo`
   custom property, and returns the imported object names plus their real-world
   combined dimensions (cm) — read from the actual mesh, not catalog metadata.
4. `POST /execute {session_id, code}` — runs an arbitrary bpy script against the
   session's `working.blend` (used for wall/floor material changes) and re-saves it.
5. `POST /render {session_id}` — frames a camera on the room, renders a preview PNG.
6. `POST /export {session_id}` — exports the final scene back to `.usdz`.
7. `GET /files/{session_id}/{filename}` — serves the render/export so the Express
   server can download and re-upload it to Supabase storage.

## Known limitations / things to verify before relying on this

- **Wall/floor/furniture classification is name-based** (`main.py`,
  `INSPECT_SCRIPT_TEMPLATE`): objects are sorted by substrings like `"wall"`,
  `"floor"`, `"door"` in their Blender object name after USD import. This depends
  entirely on how the OmniScan iOS app names objects in the exported USDZ — check
  a real export in Blender's outliner and adjust the keyword lists if the naming
  differs (e.g. ARKit RoomPlan's `CapturedRoom` categories).
- **`ikea_lib.py` talks to undocumented IKEA endpoints** (a hard-coded client ID,
  internal search/rotera APIs) — it can break without notice if IKEA changes
  their site, and there's no rate-limiting/backoff built in. Not all products
  have a 3D model available (`get_exists` filters those out of search results).
- **No structured width/depth/height from IKEA's product API** — the orchestrator
  works around this by measuring the imported GLB's actual bounding box instead
  of trusting metadata, which is why `/ikea/import` returns `dimensions_cm`.
- Sessions are never cleaned up automatically; add a TTL sweep (cron / systemd timer)
  before running this unattended for long periods.
- `/files` auth is a shared header key, not a signed URL — fine behind a VPN/private
  network, not meant to be exposed publicly as-is.

## Setup on the VM

```bash
# Blender 4.x bundles USD import/export support out of the box.
pip install -r requirements.txt
cp .env.example .env  # fill in BRIDGE_API_KEY, BRIDGE_PUBLIC_URL, IKEA_COUNTRY/IKEA_LANGUAGE
uvicorn main:app --host 0.0.0.0 --port 8000
```

`IKEA_COUNTRY`/`IKEA_LANGUAGE` (e.g. `fr`/`fr`) pick which IKEA storefront is
searched — matters for pricing, availability, and which products actually have a
3D model. `BRIDGE_PUBLIC_URL` must be an address the Express server (wherever
it's deployed) can reach — a VPN/tailscale address, an SSH tunnel, or a
reverse-proxied public URL with TLS. Point the Express server's
`BLENDER_BRIDGE_URL` / `BLENDER_BRIDGE_API_KEY` env vars at this service.
