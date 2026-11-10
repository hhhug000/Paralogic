import * as THREE from "three";

// Values of the builder's edge_kinds array.
export const EDGE_LINE = 1;
export const EDGE_SEAM = 2;

// Typed array for each base64 field the builder sends; anything else is
// Uint32. Data is little-endian, which every browser platform uses.
const ARRAY_TYPES = {
  vertices: Float32Array,
  edge_points: Float32Array,
  edge_kinds: Uint8Array,
  edge_vertices: Int32Array,
  face_areas: Float32Array,
  face_radii: Float32Array,
  edge_lengths: Float32Array,
  edge_radii: Float32Array,
};

function decodeBase64(text) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(text);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeArray(name, value) {
  if (typeof value !== "string") return value;
  const bytes = decodeBase64(value);
  const Type = ARRAY_TYPES[name] || Uint32Array;
  return new Type(bytes.buffer, bytes.byteOffset, bytes.byteLength / Type.BYTES_PER_ELEMENT);
}

// Turns the builder's base64 mesh into typed arrays.
export function decodeMesh(mesh) {
  const topology = {};
  for (const [name, value] of Object.entries(mesh.topology)) {
    topology[name] = decodeArray(name, value);
  }
  return {
    vertices: decodeArray("vertices", mesh.vertices),
    indices: decodeArray("indices", mesh.indices),
    topology,
  };
}

// Wraps the B-rep topology sent by the builder. Triangles and vertices are
// stored contiguously per CAD face, so a picked triangle maps to its face with
// one lookup and a face can be recoloured by vertex range.
export function createTopology(data) {
  const faceTriangles = data.face_triangle_offsets;
  const faceCount = faceTriangles.length - 1;
  const faceOfTriangle = new Uint32Array(faceTriangles[faceCount]);
  for (let face = 0; face < faceCount; face += 1) {
    faceOfTriangle.fill(face, faceTriangles[face], faceTriangles[face + 1]);
  }
  const edgePoints = data.edge_points;
  const edgeOffsets = data.edge_point_offsets;
  const segmentCache = new Map();

  const topology = {
    faceCount,
    edgeCount: edgeOffsets.length - 1,
    vertexCount: data.vertices.length / 3,
    faceOfTriangle,
    faceTriangleRange: (face) => [faceTriangles[face], faceTriangles[face + 1]],
    faceVertexRange: (face) => [data.face_vertex_offsets[face], data.face_vertex_offsets[face + 1]],
    faceEdges: (face) =>
      data.face_edges.subarray(data.face_edge_offsets[face], data.face_edge_offsets[face + 1]),
    faceType: (face) => data.face_types[face],
    faceArea: (face) => data.face_areas[face],
    faceRadius: (face) => data.face_radii[face],
    edgeKind: (edge) => data.edge_kinds[edge],
    edgeType: (edge) => data.edge_types[edge],
    edgeLength: (edge) => data.edge_lengths[edge],
    edgeRadius: (edge) => data.edge_radii[edge],
    edgeVertices: (edge) =>
      [data.edge_vertices[edge * 2], data.edge_vertices[edge * 2 + 1]].filter(
        (vertex) => vertex >= 0,
      ),
    edgePoint: (edge, i, target) => target.fromArray(edgePoints, (edgeOffsets[edge] + i) * 3),
    edgePointCount: (edge) => edgeOffsets[edge + 1] - edgeOffsets[edge],
    vertexPoint: (vertex, target) => target.fromArray(data.vertices, vertex * 3),
    midpoint: (edge, target) => {
      const start = topology.edgePoint(edge, 0, new THREE.Vector3());
      const end = topology.edgePoint(edge, 1, new THREE.Vector3());
      return target.copy(start).add(end).multiplyScalar(0.5);
    },
    // Line-segment positions (pairs of points) for one or more edges, as used
    // by LineSegmentsGeometry. Per-edge arrays are cached.
    segments: (edges) => {
      const parts = Array.from(edges, (edge) => {
        if (!segmentCache.has(edge)) {
          const start = edgeOffsets[edge];
          const count = edgeOffsets[edge + 1] - start;
          const array = new Float32Array(Math.max(count - 1, 0) * 6);
          for (let i = 0; i < count - 1; i += 1) {
            array.set(edgePoints.subarray((start + i) * 3, (start + i + 2) * 3), i * 6);
          }
          segmentCache.set(edge, array);
        }
        return segmentCache.get(edge);
      });
      const result = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
      let offset = 0;
      parts.forEach((part) => {
        result.set(part, offset);
        offset += part.length;
      });
      return result;
    },
  };
  topology.visibleEdges = [...Array(topology.edgeCount).keys()].filter(
    (edge) => data.edge_kinds[edge] !== EDGE_SEAM,
  );
  return topology;
}

// Squared distance from point p to segment ab, all in screen pixels.
export function segmentDistanceSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  const x = ax + t * dx - px;
  const y = ay + t * dy - py;
  return x * x + y * y;
}

// Describes a picked item for the hover tooltip, from data already in the
// mesh (no server round trip).
export function describePick(topology, picked) {
  const format = (value) => (Math.abs(value) < 5e-7 ? "0" : value.toFixed(2));
  const point = (vector) => `(${format(vector.x)}, ${format(vector.y)}, ${format(vector.z)})`;
  const title = (text) => text.charAt(0).toUpperCase() + text.slice(1);
  const parts = [];
  if (picked.kind === "face") {
    const radius = topology.faceRadius(picked.id);
    parts.push(`Face ${picked.id}`, title(topology.faceType(picked.id)));
    if (radius) parts.push(`R ${format(radius)}`);
    parts.push(`Area ${format(topology.faceArea(picked.id))}`);
  } else if (picked.kind === "edge") {
    const radius = topology.edgeRadius(picked.id);
    parts.push(`Edge ${picked.id}`, title(topology.edgeType(picked.id)));
    if (radius) parts.push(`R ${format(radius)}`);
    parts.push(`L ${format(topology.edgeLength(picked.id))}`);
  } else if (picked.kind === "vertex") {
    parts.push(`Vertex ${picked.id}`, point(topology.vertexPoint(picked.id, new THREE.Vector3())));
  } else {
    parts.push(
      `Midpoint of edge ${picked.id}`,
      point(topology.midpoint(picked.id, new THREE.Vector3())),
    );
  }
  return parts.join(" · ");
}
