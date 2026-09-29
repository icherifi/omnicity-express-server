/**
 * Shared 2D (XZ-plane) geometry primitives for the placement solver, hard-
 * constraint validator, and soft-constraint scorer - every entity in this app is
 * yaw-only rotation (nothing tilts/rolls), so plain 2D trig covers placement/
 * validation/scoring without pulling THREE.js/3D matrices into any of them.
 *
 * Convention, matching entityPositionAndYaw's extraction in roomShellService.ts:
 * for yaw degrees, an entity's own local +Z axis points world (sin(yaw),
 * cos(yaw)) and its local +X axis points world (cos(yaw), -sin(yaw)). "Forward"
 * is local +Z; "right" is local +X.
 */

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export type Vec2 = [number, number]; // [x, z]

export function yawToDir(rotationYDegrees: number): Vec2 {
  const r = rotationYDegrees * DEG2RAD;
  return [Math.sin(r), Math.cos(r)];
}

export function dirToYaw(dir: Vec2): number {
  return Math.atan2(dir[0], dir[1]) * RAD2DEG;
}

export function add(a: Vec2, b: Vec2, scale = 1): Vec2 {
  return [a[0] + b[0] * scale, a[1] + b[1] * scale];
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}

export function dot(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1];
}

export function neg(a: Vec2): Vec2 {
  return [-a[0], -a[1]];
}

export function length(a: Vec2): number {
  return Math.hypot(a[0], a[1]);
}

export function xz(p: [number, number, number]): Vec2 {
  return [p[0], p[2]];
}

/** Local +X ("right") and +Z ("forward") axes of a yaw, in world XZ. */
export function axesOf(rotationYDegrees: number): { forward: Vec2; right: Vec2 } {
  const r = rotationYDegrees * DEG2RAD;
  return { forward: [Math.sin(r), Math.cos(r)], right: [Math.cos(r), -Math.sin(r)] };
}

/** Shoelace-formula centroid of a simple polygon (loop of [x,z] points). Falls
 * back to a plain vertex average for a degenerate (zero-area) polygon. */
export function polygonCentroid(points: Vec2[]): Vec2 {
  let cx = 0;
  let cz = 0;
  let signedArea = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, z1] = points[i];
    const [x2, z2] = points[(i + 1) % points.length];
    const cross = x1 * z2 - x2 * z1;
    signedArea += cross;
    cx += (x1 + x2) * cross;
    cz += (z1 + z2) * cross;
  }
  if (signedArea === 0) {
    const n = points.length || 1;
    return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n];
  }
  signedArea *= 0.5;
  return [cx / (6 * signedArea), cz / (6 * signedArea)];
}

export function polygonArea(points: Vec2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, z1] = points[i];
    const [x2, z2] = points[(i + 1) % points.length];
    area += x1 * z2 - x2 * z1;
  }
  return Math.abs(area) / 2;
}

/** Ray-casting point-in-polygon test. */
export function pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
  const [x, z] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    const intersects = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Cheap, deliberately approximate quad-overlap test: true if either quad has a
 * corner inside the other. Misses the rare case of two quads crossing through
 * each other's edges with no corner inside either (a thin cross shape) - an
 * accepted trade for a system that already treats these checks as one signal
 * among several, not the only line of defense. */
export function quadsLikelyOverlap(a: Vec2[], b: Vec2[]): boolean {
  return a.some((p) => pointInPolygon(p, b)) || b.some((p) => pointInPolygon(p, a));
}

/** The 4 corners of a yaw-rotated rectangular footprint, in world XZ, walked in
 * perimeter order (front-right, back-right, back-left, front-left) - this list
 * doubles as a valid simple polygon for pointInPolygon, not just a bag of 4
 * points, so the order matters: right-forward/right-backward/left-backward/
 * left-forward traces the actual rectangle edges, whereas a naive ++/+-/-+/--
 * ordering connects opposite corners diagonally through the interior (a
 * self-intersecting "bowtie" that silently breaks polygon-overlap tests using
 * these corners as one side of the test, even though point-in-polygon tests
 * that treat them merely as 4 independent sample points are unaffected). */
export function footprintCorners(center: Vec2, rotationYDegrees: number, widthM: number, depthM: number): Vec2[] {
  const { forward, right } = axesOf(rotationYDegrees);
  const hw = widthM / 2;
  const hd = depthM / 2;
  return [
    add(add(center, right, hw), forward, hd),
    add(add(center, right, hw), forward, -hd),
    add(add(center, right, -hw), forward, -hd),
    add(add(center, right, -hw), forward, hd),
  ];
}
