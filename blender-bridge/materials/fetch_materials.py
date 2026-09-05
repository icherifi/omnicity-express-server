#!/usr/bin/env python3
"""Downloads the CC0 floor textures listed in manifest.json from Poly Haven
(https://polyhaven.com, CC0 — free for commercial use, no attribution required).

Run once per VM/checkout: python3 fetch_materials.py
Re-run is safe/idempotent — existing files are left alone.
"""

import json
import pathlib
import urllib.request

HERE = pathlib.Path(__file__).parent
MANIFEST = json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))

# Local file name -> Poly Haven's map key (see https://api.polyhaven.com/files/<asset>)
MAP_TYPES = {"diffuse": "Diffuse", "normal": "nor_gl", "roughness": "Rough"}


USER_AGENT = "omnicity-staging-material-fetch (https://github.com/icherifi/omnicity-express-server)"


def _get(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    return urllib.request.urlopen(req)


def polyhaven_jpg_url(asset_id: str, map_key: str, resolution: str = "1k") -> str:
    with _get(f"https://api.polyhaven.com/files/{asset_id}") as r:
        data = json.load(r)
    return data[map_key][resolution]["jpg"]["url"]


def main():
    for floor in MANIFEST["floors"]:
        asset_id = floor["source"].split(":", 1)[1]
        out_dir = HERE / floor["material_id"]
        out_dir.mkdir(exist_ok=True)

        for local_name, ph_key in MAP_TYPES.items():
            dest = out_dir / f"{local_name}.jpg"
            if dest.exists():
                print(f"skip {dest} (already present)")
                continue
            url = polyhaven_jpg_url(asset_id, ph_key)
            print(f"downloading {url} -> {dest}")
            with _get(url) as r, open(dest, "wb") as f:
                f.write(r.read())

    print("Done.")


if __name__ == "__main__":
    main()
