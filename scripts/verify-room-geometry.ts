/** Standalone sanity check for Phase 3's SceneInspection.walls/doors/windows/
 * sections and buildRoomGeometry() against the real fixture. */
import fs from "fs";
import path from "path";
import { inspectRoom, buildRoomGeometry } from "../src/services/roomShellService";
import { RoomPlanCapturedRoom } from "../src/types/staging.types";

const fixturePath = path.join(__dirname, "..", "src", "services", "__fixtures__", "sample-scan.json");
const serialized = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as RoomPlanCapturedRoom;

const inspection = inspectRoom(serialized);
console.log("walls:", inspection.walls.length, "doors:", inspection.doors.length, "windows:", inspection.windows.length, "sections:", inspection.sections.length);
console.log("sample wall:", inspection.walls[0]);
console.log("sample door:", inspection.doors[0]);
console.log("sections:", inspection.sections);

const geo = buildRoomGeometry(serialized, inspection.room);
console.log("\ngeometry walls:", geo.walls.length, "doors:", geo.doors.length, "windows:", geo.windows.length);
console.log("floorPolygon points:", geo.floorPolygon?.length ?? "none");
console.log("sample wall descriptor:", geo.walls[0]);
const doorWithParent = geo.doors.find((d) => d.parentWallIdentifier);
console.log("a door with parentWallIdentifier:", doorWithParent);
console.log("that parent wall exists in geo.walls:", geo.walls.some((w) => w.identifier === doorWithParent?.parentWallIdentifier));
