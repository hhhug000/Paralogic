import * as THREE from "three";

// Silhouette ("contour") edges of curved faces: mesh edges inside a non-planar
// CAD face where one neighbouring triangle faces the camera and the other
// faces away. CAD edges alone leave cylinders and spheres without an outline.
// The candidate edges are found once per mesh; update() only does two dot
// products per candidate, and is called when the camera moves.
export function createSilhouette(positions, indices, topology, material) {
  const vertexCount = positions.length / 3;
  const candidates = [];
  const normals = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const triangleNormal = (triangle, target) => {
    a.fromArray(positions, indices[triangle * 3] * 3);
    b.fromArray(positions, indices[triangle * 3 + 1] * 3);
    c.fromArray(positions, indices[triangle * 3 + 2] * 3);
    return target.subVectors(c, b).cross(a.sub(b)).normalize();
  };

  const normal = new THREE.Vector3();
  for (let face = 0; face < topology.faceCount; face += 1) {
    if (topology.faceType(face) === "plane") continue;
    const [first, last] = topology.faceTriangleRange(face);
    // Vertices are only shared within a face, so numeric keys suffice.
    const open = new Map();
    for (let triangle = first; triangle < last; triangle += 1) {
      for (let corner = 0; corner < 3; corner += 1) {
        const from = indices[triangle * 3 + corner];
        const to = indices[triangle * 3 + ((corner + 1) % 3)];
        const key = from < to ? from * vertexCount + to : to * vertexCount + from;
        const other = open.get(key);
        if (other === undefined) {
          open.set(key, triangle);
        } else {
          open.delete(key);
          candidates.push(from, to);
          triangleNormal(other, normal);
          normals.push(normal.x, normal.y, normal.z);
          triangleNormal(triangle, normal);
          normals.push(normal.x, normal.y, normal.z);
        }
      }
    }
  }

  const edgeVertices = Uint32Array.from(candidates);
  const edgeNormals = Float32Array.from(normals);
  const edgeCount = edgeVertices.length / 2;
  const output = new Float32Array(Math.max(edgeCount, 1) * 6);
  const geometry = new THREE.BufferGeometry();
  const attribute = new THREE.BufferAttribute(output, 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", attribute);
  geometry.setDrawRange(0, 0);
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  lines.renderOrder = 3;

  // eye is the camera position and forward its view direction, both in the
  // mesh's coordinates.
  const update = (eye, forward, orthographic) => {
    let written = 0;
    for (let edge = 0; edge < edgeCount; edge += 1) {
      const from = edgeVertices[edge * 2] * 3;
      const to = edgeVertices[edge * 2 + 1] * 3;
      let vx = forward.x;
      let vy = forward.y;
      let vz = forward.z;
      if (!orthographic) {
        vx = (positions[from] + positions[to]) / 2 - eye.x;
        vy = (positions[from + 1] + positions[to + 1]) / 2 - eye.y;
        vz = (positions[from + 2] + positions[to + 2]) / 2 - eye.z;
      }
      const n = edge * 6;
      const first = edgeNormals[n] * vx + edgeNormals[n + 1] * vy + edgeNormals[n + 2] * vz;
      const second = edgeNormals[n + 3] * vx + edgeNormals[n + 4] * vy + edgeNormals[n + 5] * vz;
      if ((first < 0) !== (second < 0)) {
        output[written] = positions[from];
        output[written + 1] = positions[from + 1];
        output[written + 2] = positions[from + 2];
        output[written + 3] = positions[to];
        output[written + 4] = positions[to + 1];
        output[written + 5] = positions[to + 2];
        written += 6;
      }
    }
    geometry.setDrawRange(0, written / 3);
    if (written) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, written);
      attribute.needsUpdate = true;
    }
  };

  return { lines, update, edgeCount };
}
