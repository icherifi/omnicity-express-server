/**
 * Measures GLB model bounding boxes without a full 3D engine. `THREE.GLTFLoader`
 * can't run headless — it resolves textures via `ImageLoader`, which calls
 * `document.createElementNS(...)` and throws outside a browser. But the glTF 2.0
 * spec requires every POSITION accessor to carry min/max in its JSON metadata
 * (this stays valid even under Draco compression, specifically so tools can get
 * bounds without decoding) — so bounding boxes only need the GLB's JSON chunk,
 * never its binary buffer.
 */

import fs from "fs";
import * as THREE from "three";

interface GltfAccessor {
  min?: number[];
  max?: number[];
}
interface GltfPrimitive {
  attributes: Record<string, number>;
}
interface GltfMesh {
  primitives: GltfPrimitive[];
}
interface GltfNode {
  children?: number[];
  mesh?: number;
  matrix?: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}
interface GltfJson {
  scene?: number;
  scenes?: { nodes: number[] }[];
  nodes?: GltfNode[];
  meshes?: GltfMesh[];
  accessors?: GltfAccessor[];
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_TYPE_JSON = 0x4e4f534a; // "JSON"

function readGltfJson(buffer: Buffer): GltfJson {
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) {
    // Not a binary .glb container - assume it's a plain .gltf JSON file.
    return JSON.parse(buffer.toString("utf-8"));
  }
  // Header: magic(4) version(4) totalLength(4) = 12 bytes, then chunk 0.
  const chunkLength = buffer.readUInt32LE(12);
  const chunkType = buffer.readUInt32LE(16);
  if (chunkType !== CHUNK_TYPE_JSON) throw new Error("First GLB chunk is not JSON");
  return JSON.parse(buffer.toString("utf-8", 20, 20 + chunkLength));
}

function nodeLocalMatrix(node: GltfNode): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (node.matrix) return m.fromArray(node.matrix);
  const t = new THREE.Vector3(...(node.translation ?? [0, 0, 0]));
  const r = new THREE.Quaternion(...(node.rotation ?? [0, 0, 0, 1]));
  const s = new THREE.Vector3(...(node.scale ?? [1, 1, 1]));
  return m.compose(t, r, s);
}

function expandByLocalAabb(box: THREE.Box3, min: number[], max: number[], matrix: THREE.Matrix4): void {
  const [minX, minY, minZ] = min;
  const [maxX, maxY, maxZ] = max;
  const corners: [number, number, number][] = [
    [minX, minY, minZ], [maxX, minY, minZ], [minX, maxY, minZ], [minX, minY, maxZ],
    [maxX, maxY, minZ], [maxX, minY, maxZ], [minX, maxY, maxZ], [maxX, maxY, maxZ],
  ];
  for (const corner of corners) box.expandByPoint(new THREE.Vector3(...corner).applyMatrix4(matrix));
}

export interface LocalBoundingBox {
  min: [number, number, number];
  max: [number, number, number];
}

const EMPTY_BOX: LocalBoundingBox = { min: [0, 0, 0], max: [0, 0, 0] };

/** The model's own bounding box, in its as-authored local space (no placement transform applied). */
export function computeLocalBoundingBox(glbPath: string): LocalBoundingBox {
  const gltf = readGltfJson(fs.readFileSync(glbPath));
  const box = new THREE.Box3();
  const rootNodeIndices = gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? [];

  const visit = (nodeIndex: number, parentMatrix: THREE.Matrix4): void => {
    const node = gltf.nodes?.[nodeIndex];
    if (!node) return;
    const worldMatrix = parentMatrix.clone().multiply(nodeLocalMatrix(node));

    if (node.mesh !== undefined) {
      for (const prim of gltf.meshes?.[node.mesh]?.primitives ?? []) {
        const accessor = gltf.accessors?.[prim.attributes.POSITION];
        if (accessor?.min && accessor?.max) expandByLocalAabb(box, accessor.min, accessor.max, worldMatrix);
      }
    }
    for (const child of node.children ?? []) visit(child, worldMatrix);
  };

  for (const rootIndex of rootNodeIndices) visit(rootIndex, new THREE.Matrix4());

  if (box.isEmpty()) return EMPTY_BOX;
  return { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
}

export function dimensionsCm(box: LocalBoundingBox): [number, number, number] {
  return [
    (box.max[0] - box.min[0]) * 100,
    (box.max[1] - box.min[1]) * 100,
    (box.max[2] - box.min[2]) * 100,
  ];
}

/** The model's world-space bounding box once placed at a given position/yaw. */
export function placedBoundingBox(
  local: LocalBoundingBox,
  position: [number, number, number],
  rotationYDegrees: number
): LocalBoundingBox {
  const quaternion = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    THREE.MathUtils.degToRad(rotationYDegrees)
  );
  const matrix = new THREE.Matrix4().compose(new THREE.Vector3(...position), quaternion, new THREE.Vector3(1, 1, 1));

  const box = new THREE.Box3();
  expandByLocalAabb(box, local.min, local.max, matrix);
  return { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
}

/** Volume (m^3) of the overlap between two world-space boxes, 0 if they don't intersect. */
export function boxOverlapVolume(a: LocalBoundingBox, b: LocalBoundingBox): number {
  const boxA = new THREE.Box3(new THREE.Vector3(...a.min), new THREE.Vector3(...a.max));
  const boxB = new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
  const overlap = boxA.clone().intersect(boxB);
  if (overlap.isEmpty()) return 0;
  const size = overlap.getSize(new THREE.Vector3());
  return size.x * size.y * size.z;
}
