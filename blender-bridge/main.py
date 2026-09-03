"""Blender bridge: receives staging commands from the Express orchestrator and
runs them against headless Blender on this VM.

Each scan being staged gets a "session": a working directory holding the
imported scene as a .blend file, so state can persist across the many small
/execute calls the orchestrator makes (Blender itself is stateless between
subprocess invocations - see blender_executor.py).
"""

import json
import logging
import os
import shutil
import uuid
from pathlib import Path

import requests
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

load_dotenv()

from blender_executor import BlenderScriptError, run_script
from ikea_lib import IkeaApiWrapper, IkeaException

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("blender-bridge")

API_KEY = os.environ.get("BRIDGE_API_KEY")
SESSIONS_DIR = Path(os.environ.get("BRIDGE_SESSIONS_DIR", "sessions"))
SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
# Base URL this bridge is reachable at from the Express server (e.g. https://blender-vm.example.com or a VPN address).
PUBLIC_BASE_URL = os.environ.get("BRIDGE_PUBLIC_URL", "http://localhost:8000").rstrip("/")

ikea = IkeaApiWrapper(os.environ.get("IKEA_COUNTRY", "fr"), os.environ.get("IKEA_LANGUAGE", "fr"))
ikea.cache_dir = Path(os.environ.get("IKEA_CACHE_DIR", "ikea_cache"))
ikea.cache_dir.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="blender-bridge")


def require_api_key(x_bridge_api_key: str | None = Header(default=None)):
    if not API_KEY:
        raise HTTPException(500, "BRIDGE_API_KEY is not configured on the bridge")
    if x_bridge_api_key != API_KEY:
        raise HTTPException(401, "Invalid or missing x-bridge-api-key header")


def session_dir(session_id: str) -> Path:
    d = SESSIONS_DIR / session_id
    if not d.is_dir():
        raise HTTPException(404, f"Unknown session_id {session_id}")
    return d


class InspectRequest(BaseModel):
    usdz_url: str


class ExecuteRequest(BaseModel):
    session_id: str
    code: str


class SessionRequest(BaseModel):
    session_id: str


class IkeaImportRequest(BaseModel):
    session_id: str
    item_no: str
    position: list[float]
    rotation_z_degrees: float
    replace_object_name: str | None = None


INSPECT_SCRIPT_TEMPLATE = """
import json

# --factory-startup loads Blender's default scene (Cube/Camera/Light) — clear it
# before importing the scan, otherwise the default Cube gets inspected as a
# stray "unknown" furniture item.
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

bpy.ops.wm.usd_import(filepath={scan_path!r}, import_meshes=True, import_materials=True, import_lights=True)

def world_bbox(obj):
    corners = [obj.matrix_world @ mathutils.Vector(c) for c in obj.bound_box]
    xs = [c.x for c in corners]
    ys = [c.y for c in corners]
    zs = [c.z for c in corners]
    return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))

import mathutils
import re

# RoomPlan/ARKit-exported USDZ names objects "<Category><Index>" (Wall0, Chair2,
# Storage6...) — confirmed against a real OmniScan export. Stripping the trailing
# index gives the category directly, no keyword guessing needed.
def base_category(name):
    return re.sub(r'\\d+$', '', name).lower()

WALL_CATEGORIES = {{"wall"}}
FLOOR_CATEGORIES = {{"floor", "ground"}}
CEILING_CATEGORIES = {{"ceiling"}}
SKIP_CATEGORIES = {{"door", "window", "opening"}}

walls, floors, ceilings, objects = [], [], [], []
overall_min = [float("inf")] * 3
overall_max = [float("-inf")] * 3

for obj in bpy.context.scene.objects:
    if obj.type != 'MESH':
        continue
    category = base_category(obj.name)
    bmin, bmax = world_bbox(obj)
    for i in range(3):
        overall_min[i] = min(overall_min[i], bmin[i])
        overall_max[i] = max(overall_max[i], bmax[i])

    if category in WALL_CATEGORIES:
        walls.append(obj.name)
        continue
    if category in FLOOR_CATEGORIES:
        floors.append(obj.name)
        continue
    if category in CEILING_CATEGORIES:
        ceilings.append(obj.name)
        continue
    if category in SKIP_CATEGORIES:
        continue

    dims_cm = [(bmax[0] - bmin[0]) * 100, (bmax[1] - bmin[1]) * 100, (bmax[2] - bmin[2]) * 100]
    loc = obj.matrix_world.translation
    rot_z = math.degrees(obj.matrix_world.to_euler().z)

    objects.append({{
        "object_name": obj.name,
        "guessed_category": category,
        "position": [loc.x, loc.y, loc.z],
        "rotation_z_degrees": rot_z,
        "dimensions_cm": dims_cm,
    }})

result = {{
    "room": {{
        "bounds_min": overall_min,
        "bounds_max": overall_max,
        "wall_object_names": walls,
        "floor_object_names": floors,
        "ceiling_object_names": ceilings,
    }},
    "objects": objects,
}}

bpy.ops.wm.save_as_mainfile(filepath={working_blend!r})
print("INSPECT_RESULT_JSON:" + json.dumps(result))
"""

EXECUTE_SCRIPT_TEMPLATE = """
{user_code}

bpy.ops.wm.save_as_mainfile(filepath={working_blend!r})
"""

RENDER_SCRIPT_TEMPLATE = """
import mathutils

cam_data = bpy.data.cameras.get("staging_preview_cam") or bpy.data.cameras.new("staging_preview_cam")
cam_obj = bpy.data.objects.get("staging_preview_cam")
if cam_obj is None:
    cam_obj = bpy.data.objects.new("staging_preview_cam", cam_data)
    bpy.context.scene.collection.objects.link(cam_obj)

center = [(({bmin_x}) + ({bmax_x})) / 2, (({bmin_y}) + ({bmax_y})) / 2, (({bmin_z}) + ({bmax_z})) / 2]
span = max(({bmax_x}) - ({bmin_x}), ({bmax_y}) - ({bmin_y}), 2.0)
cam_obj.location = (center[0] + span * 0.9, center[1] - span * 0.9, center[2] + span * 0.9)
direction = mathutils.Vector(center) - mathutils.Vector(cam_obj.location)
cam_obj.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
bpy.context.scene.camera = cam_obj

if "staging_sun" not in bpy.data.objects:
    sun_data = bpy.data.lights.new("staging_sun", type='SUN')
    sun_data.energy = 3.0
    sun_obj = bpy.data.objects.new("staging_sun", sun_data)
    sun_obj.rotation_euler = (0.9, 0.0, 0.6)
    bpy.context.scene.collection.objects.link(sun_obj)

scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items] else 'BLENDER_EEVEE'
scene.render.resolution_x = 1280
scene.render.resolution_y = 720
scene.render.filepath = {output_path!r}
bpy.ops.render.render(write_still=True)
"""

EXPORT_SCRIPT_TEMPLATE = """
bpy.ops.wm.usd_export(filepath={output_path!r}, selected_objects_only=False, export_materials=True)
"""

IKEA_IMPORT_SCRIPT_TEMPLATE = """
import json
import mathutils

existing = set(bpy.data.objects)

replace_name = {replace_object_name!r}
if replace_name:
    obj = bpy.data.objects.get(replace_name)
    if obj is not None:
        bpy.data.objects.remove(obj, do_unlink=True)

bpy.ops.import_scene.gltf(filepath={glb_path!r})
imported = [o for o in bpy.data.objects if o not in existing]
imported_names = set(o.name for o in imported)
top_level = [o for o in imported if o.parent is None or o.parent.name not in imported_names]

for obj in top_level:
    obj.location = ({x}, {y}, {z})
    obj.rotation_euler = (0, 0, math.radians({rotation_z}))

for obj in imported:
    obj["ikeaItemNo"] = {item_no!r}

overall_min = [float("inf")] * 3
overall_max = [float("-inf")] * 3
for obj in imported:
    if obj.type != 'MESH':
        continue
    for corner in obj.bound_box:
        world_corner = obj.matrix_world @ mathutils.Vector(corner)
        for i in range(3):
            overall_min[i] = min(overall_min[i], world_corner[i])
            overall_max[i] = max(overall_max[i], world_corner[i])

if overall_min[0] == float("inf"):
    dims_cm = [0, 0, 0]
else:
    dims_cm = [(overall_max[i] - overall_min[i]) * 100 for i in range(3)]

result = {{"object_names": [o.name for o in imported], "dimensions_cm": dims_cm}}
bpy.ops.wm.save_as_mainfile(filepath={working_blend!r})
print("IMPORT_RESULT_JSON:" + json.dumps(result))
"""


@app.post("/inspect")
def inspect(req: InspectRequest, _auth=Depends(require_api_key)):
    session_id = uuid.uuid4().hex
    sdir = SESSIONS_DIR / session_id
    sdir.mkdir(parents=True, exist_ok=True)

    scan_path = sdir / "scan.usdz"
    resp = requests.get(req.usdz_url, timeout=60)
    resp.raise_for_status()
    scan_path.write_bytes(resp.content)

    working_blend = sdir / "working.blend"
    script = INSPECT_SCRIPT_TEMPLATE.format(scan_path=str(scan_path), working_blend=str(working_blend))

    try:
        output = run_script(script)
    except BlenderScriptError as e:
        shutil.rmtree(sdir, ignore_errors=True)
        raise HTTPException(500, str(e))

    marker = "INSPECT_RESULT_JSON:"
    line = next((l for l in output.splitlines() if l.startswith(marker)), None)
    if line is None:
        raise HTTPException(500, f"Bridge could not parse inspection output: {output}")

    result = json.loads(line[len(marker):])
    (sdir / "last_inspection.json").write_text(json.dumps(result), encoding="utf-8")
    return {"session_id": session_id, "room": result["room"], "objects": result["objects"]}


@app.post("/execute")
def execute(req: ExecuteRequest, _auth=Depends(require_api_key)):
    sdir = session_dir(req.session_id)
    working_blend = sdir / "working.blend"
    script = EXECUTE_SCRIPT_TEMPLATE.format(user_code=req.code, working_blend=str(working_blend))

    try:
        output = run_script(script, blend_file=working_blend)
        return {"output": output, "success": True}
    except BlenderScriptError as e:
        return {"output": str(e), "success": False}


@app.post("/render")
def render(req: SessionRequest, _auth=Depends(require_api_key)):
    sdir = session_dir(req.session_id)
    working_blend = sdir / "working.blend"
    output_path = sdir / "preview.png"

    inspect_json = sdir / "last_inspection.json"
    if inspect_json.is_file():
        room = json.loads(inspect_json.read_text())["room"]
        bmin, bmax = room["bounds_min"], room["bounds_max"]
    else:
        bmin, bmax = [-2, -2, 0], [2, 2, 2.4]

    script = RENDER_SCRIPT_TEMPLATE.format(
        bmin_x=bmin[0], bmin_y=bmin[1], bmin_z=bmin[2],
        bmax_x=bmax[0], bmax_y=bmax[1], bmax_z=bmax[2],
        output_path=str(output_path),
    )

    try:
        run_script(script, blend_file=working_blend)
    except BlenderScriptError as e:
        raise HTTPException(500, str(e))

    return {"file_url": f"{PUBLIC_BASE_URL}/files/{req.session_id}/preview.png"}


@app.post("/export")
def export(req: SessionRequest, _auth=Depends(require_api_key)):
    sdir = session_dir(req.session_id)
    working_blend = sdir / "working.blend"
    output_path = sdir / "staged.usdz"

    script = EXPORT_SCRIPT_TEMPLATE.format(output_path=str(output_path))

    try:
        run_script(script, blend_file=working_blend)
    except BlenderScriptError as e:
        raise HTTPException(500, str(e))

    return {"file_url": f"{PUBLIC_BASE_URL}/files/{req.session_id}/staged.usdz"}


@app.get("/ikea/search")
def ikea_search(q: str, _auth=Depends(require_api_key)):
    try:
        return ikea.search(q)
    except IkeaException as e:
        raise HTTPException(502, str(e))


@app.get("/ikea/product/{item_no}")
def ikea_product(item_no: str, _auth=Depends(require_api_key)):
    try:
        return ikea.get_pip(ikea.compact_item_no(item_no))
    except IkeaException as e:
        raise HTTPException(502, str(e))


@app.post("/ikea/import")
def ikea_import(req: IkeaImportRequest, _auth=Depends(require_api_key)):
    sdir = session_dir(req.session_id)
    working_blend = sdir / "working.blend"
    item_no = ikea.compact_item_no(req.item_no)

    try:
        glb_path = ikea.get_model(item_no)
    except IkeaException as e:
        return {"output": str(e), "success": False, "object_names": [], "dimensions_cm": [0, 0, 0]}

    script = IKEA_IMPORT_SCRIPT_TEMPLATE.format(
        replace_object_name=req.replace_object_name,
        glb_path=str(Path(glb_path).resolve()),
        x=req.position[0],
        y=req.position[1],
        z=req.position[2],
        rotation_z=req.rotation_z_degrees,
        item_no=item_no,
        working_blend=str(working_blend),
    )

    try:
        output = run_script(script, blend_file=working_blend)
    except BlenderScriptError as e:
        return {"output": str(e), "success": False, "object_names": [], "dimensions_cm": [0, 0, 0]}

    marker = "IMPORT_RESULT_JSON:"
    line = next((l for l in output.splitlines() if l.startswith(marker)), None)
    if line is None:
        return {"output": output, "success": False, "object_names": [], "dimensions_cm": [0, 0, 0]}

    result = json.loads(line[len(marker):])
    return {"output": output, "success": True, "object_names": result["object_names"], "dimensions_cm": result["dimensions_cm"]}


@app.get("/files/{session_id}/{filename}")
def get_file(session_id: str, filename: str, x_bridge_api_key: str | None = Header(default=None)):
    require_api_key(x_bridge_api_key)
    path = SESSIONS_DIR / session_id / filename
    if not path.is_file():
        raise HTTPException(404, "File not found")
    return FileResponse(path)
