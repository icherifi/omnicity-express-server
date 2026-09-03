"""Runs Python scripts inside headless Blender as subprocesses.

Each call spawns `blender --background [blend_file] --python <script>`. Blender
keeps no state between calls, so callers that need persistence (this bridge's
per-scan sessions) must pass blend_file in and have the script save back to it.
"""

import os
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

BLENDER_EXECUTABLE = os.environ.get("BLENDER_EXECUTABLE", "blender")
SCRIPT_TIMEOUT_SECONDS = int(os.environ.get("BLENDER_SCRIPT_TIMEOUT", "180"))


class BlenderScriptError(Exception):
    pass


def _wrap(code: str, script_id: str) -> str:
    indented = "\n".join(f"    {line}" if line.strip() else line for line in code.split("\n"))
    return f'''
import sys
import math
import traceback
import bpy

SCRIPT_ID = "{script_id}"
print(f"SCRIPT_START:{{SCRIPT_ID}}")

try:
{indented}
    print(f"SCRIPT_SUCCESS:{{SCRIPT_ID}}")
except Exception:
    print(f"SCRIPT_ERROR:{{SCRIPT_ID}}")
    print(traceback.format_exc())
    sys.exit(1)
'''


def run_script(code: str, blend_file: Path | None = None, timeout: int | None = None) -> str:
    """Run `code` in headless Blender, optionally starting from an existing .blend file.

    Returns combined stdout. Raises BlenderScriptError on failure or timeout.
    """
    script_id = uuid.uuid4().hex
    wrapped = _wrap(code, script_id)

    with tempfile.TemporaryDirectory(prefix="blender_bridge_") as tmp_dir:
        script_path = Path(tmp_dir) / "script.py"
        script_path.write_text(wrapped, encoding="utf-8")

        cmd = [BLENDER_EXECUTABLE, "--background"]
        if blend_file is not None:
            cmd.append(str(blend_file))
        cmd.extend(["--factory-startup", "--enable-autoexec", "--python", str(script_path), "--"])

        start = time.time()
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout or SCRIPT_TIMEOUT_SECONDS,
                cwd=tmp_dir,
            )
        except subprocess.TimeoutExpired as e:
            raise BlenderScriptError(f"Script timed out after {timeout or SCRIPT_TIMEOUT_SECONDS}s") from e

        stdout = result.stdout or ""
        stderr = result.stderr or ""
        elapsed = time.time() - start

        if f"SCRIPT_START:{script_id}" not in stdout:
            raise BlenderScriptError(f"Blender did not run the script (exit {result.returncode}).\n{stderr}\n{stdout}")

        if f"SCRIPT_ERROR:{script_id}" in stdout:
            raise BlenderScriptError(stdout.split(f"SCRIPT_ERROR:{script_id}", 1)[1].strip())

        if f"SCRIPT_SUCCESS:{script_id}" not in stdout:
            raise BlenderScriptError(f"Blender exited without a success marker (exit {result.returncode}).\n{stderr}\n{stdout}")

        return stdout
