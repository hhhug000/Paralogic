import * as THREE from "three";

// A CAD view cube with bevelled edges and corners: 6 faces, 12 edges and 8
// corners, each a click target that turns the view to look from that
// direction, plus an X/Y/Z triad. It is drawn by its own small renderer with
// an orthographic camera that copies the main camera's orientation.
//
// Geometry is defined in CAD coordinates (Z up) and rotated into the Y-up
// Three.js world by `cadQuaternion`, exactly like the model.

const HALF = 1; // half the cube's size
const CHAMFER = 0.3; // width of the bevel, in the same units
const INNER = HALF - CHAMFER;

const COLORS = {
  face: 0x4d5054,
  bevel: 0x5f6266,
  outline: 0x1a1b1d,
  label: "#f1f2f3",
  hover: 0x8a4a12, // added as emissive light, so the region glows orange
  x: 0xe0574f,
  y: 0x5cbf62,
  z: 0x4f8fe6,
};

// Each face: outward normal, the label, and the label's right and up
// directions as seen from that face's standard view.
const FACES = [
  { normal: [0, -1, 0], label: "Front", right: [1, 0, 0], up: [0, 0, 1] },
  { normal: [0, 1, 0], label: "Back", right: [-1, 0, 0], up: [0, 0, 1] },
  { normal: [1, 0, 0], label: "Right", right: [0, 1, 0], up: [0, 0, 1] },
  { normal: [-1, 0, 0], label: "Left", right: [0, -1, 0], up: [0, 0, 1] },
  { normal: [0, 0, 1], label: "Top", right: [1, 0, 0], up: [0, 1, 0] },
  { normal: [0, 0, -1], label: "Bottom", right: [1, 0, 0], up: [0, -1, 0] },
];

function labelTexture(text) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  context.fillStyle = `#${COLORS.face.toString(16).padStart(6, "0")}`;
  context.fillRect(0, 0, 512, 512);
  context.fillStyle = COLORS.label;
  context.font = `600 ${text.length > 5 ? 100 : 116}px Inter, "Segoe UI", system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, 256, 264);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// Builds a flat polygon (in order around its outline) facing away from the
// cube centre.
function polygonGeometry(points) {
  const center = points.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(points.length);
  const normal = new THREE.Vector3()
    .subVectors(points[1], points[0])
    .cross(new THREE.Vector3().subVectors(points[2], points[0]));
  const ordered = normal.dot(center) < 0 ? [...points].reverse() : points;
  const positions = [];
  for (let i = 1; i < ordered.length - 1; i += 1) {
    for (const p of [ordered[0], ordered[i], ordered[i + 1]]) positions.push(p.x, p.y, p.z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return { geometry, outline: ordered };
}

function vector(values) {
  return new THREE.Vector3(...values);
}

// Point with the given coordinate along axis `i` and the other two from `rest`.
function point(i, value, j, jValue, k, kValue) {
  const p = [0, 0, 0];
  p[i] = value;
  p[j] = jValue;
  p[k] = kValue;
  return new THREE.Vector3(...p);
}

export function createViewCube({ controls, cadQuaternion, onView, size = 132 }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(size, size);
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.className = "view-cube-canvas";

  const scene = new THREE.Scene();
  // Large enough that the triad tips and labels stay inside at any angle.
  const extent = 2.2;
  const camera = new THREE.OrthographicCamera(-extent, extent, extent, -extent, 0.1, 20);
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const light = new THREE.DirectionalLight(0xffffff, 1.4);
  scene.add(light);

  const cube = new THREE.Group();
  cube.quaternion.copy(cadQuaternion);
  scene.add(cube);

  const regions = [];
  const outlinePositions = [];
  const addOutline = (points) => {
    points.forEach((p, i) => {
      const q = points[(i + 1) % points.length];
      outlinePositions.push(p.x, p.y, p.z, q.x, q.y, q.z);
    });
  };
  const addRegion = (mesh, direction, up) => {
    mesh.userData.region = { direction: direction.normalize(), up };
    cube.add(mesh);
    regions.push(mesh);
  };

  // Faces, with their labels.
  FACES.forEach(({ normal, label, right, up }) => {
    const n = vector(normal);
    const r = vector(right);
    const u = vector(up);
    const geometry = new THREE.PlaneGeometry(INNER * 2, INNER * 2);
    geometry.applyMatrix4(new THREE.Matrix4().makeBasis(r, u, n).setPosition(n.clone().multiplyScalar(HALF)));
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshLambertMaterial({ map: labelTexture(label) }),
    );
    addRegion(mesh, n.clone(), u.clone());
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([a, b]) =>
      n.clone().multiplyScalar(HALF).addScaledVector(r, a * INNER).addScaledVector(u, b * INNER),
    );
    addOutline(corners);
  });

  const bevel = () => new THREE.MeshLambertMaterial({ color: COLORS.bevel });
  // Edges: the bevel strip between two faces.
  for (let i = 0; i < 3; i += 1) {
    for (let j = i + 1; j < 3; j += 1) {
      const k = 3 - i - j;
      for (const si of [-1, 1]) {
        for (const sj of [-1, 1]) {
          const points = [
            point(i, si * HALF, j, sj * INNER, k, -INNER),
            point(i, si * HALF, j, sj * INNER, k, INNER),
            point(i, si * INNER, j, sj * HALF, k, INNER),
            point(i, si * INNER, j, sj * HALF, k, -INNER),
          ];
          const { geometry, outline } = polygonGeometry(points);
          addRegion(new THREE.Mesh(geometry, bevel()), point(i, si, j, sj, k, 0), null);
          addOutline(outline);
        }
      }
    }
  }
  // Corners: the small triangle where three bevels meet.
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const points = [
          new THREE.Vector3(sx * HALF, sy * INNER, sz * INNER),
          new THREE.Vector3(sx * INNER, sy * HALF, sz * INNER),
          new THREE.Vector3(sx * INNER, sy * INNER, sz * HALF),
        ];
        const { geometry, outline } = polygonGeometry(points);
        addRegion(new THREE.Mesh(geometry, bevel()), new THREE.Vector3(sx, sy, sz), null);
        addOutline(outline);
      }
    }
  }

  const outlineGeometry = new THREE.BufferGeometry();
  outlineGeometry.setAttribute("position", new THREE.Float32BufferAttribute(outlinePositions, 3));
  const outline = new THREE.LineSegments(
    outlineGeometry,
    new THREE.LineBasicMaterial({ color: COLORS.outline }),
  );
  outline.scale.setScalar(1.003);
  cube.add(outline);

  // Axis triad from the front-left-bottom corner, like the model's axes.
  const triad = new THREE.Group();
  const corner = new THREE.Vector3(-1.12, -1.12, -1.12);
  const axisLength = 2.35;
  [
    ["X", [1, 0, 0], COLORS.x],
    ["Y", [0, 1, 0], COLORS.y],
    ["Z", [0, 0, 1], COLORS.z],
  ].forEach(([name, direction, color]) => {
    const end = corner.clone().addScaledVector(vector(direction), axisLength);
    const geometry = new THREE.BufferGeometry().setFromPoints([corner, end]);
    triad.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color })));
    const label = document.createElement("canvas");
    label.width = 64;
    label.height = 64;
    const context = label.getContext("2d");
    context.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
    context.font = "600 44px Inter, system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(name, 32, 34);
    const texture = new THREE.CanvasTexture(label);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
    sprite.position.copy(end).addScaledVector(vector(direction), 0.18);
    sprite.scale.setScalar(0.36);
    triad.add(sprite);
  });
  cube.add(triad);

  // --- Interaction ---------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hovered = null;
  const setHovered = (mesh) => {
    if (mesh === hovered) return;
    if (hovered) hovered.material.emissive.setHex(0x000000);
    hovered = mesh;
    if (hovered) hovered.material.emissive.setHex(COLORS.hover);
    canvas.style.cursor = hovered ? "pointer" : "";
  };
  const regionAt = (event) => {
    const bounds = canvas.getBoundingClientRect();
    pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(regions, false)[0]?.object || null;
  };

  // Dragging the cube orbits the view; a click without dragging picks a view.
  let drag = null;
  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    canvas.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false };
  };
  const onPointerMove = (event) => {
    if (drag) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3) {
        drag.moved = true;
        setHovered(null);
      }
      if (drag.moved) controls.orbit(dx, dy);
      return;
    }
    setHovered(regionAt(event));
  };
  const onPointerUp = (event) => {
    if (!drag) return;
    const wasDrag = drag.moved;
    drag = null;
    canvas.releasePointerCapture(event.pointerId);
    if (wasDrag) return;
    const mesh = regionAt(event);
    if (!mesh) return;
    const { direction, up } = mesh.userData.region;
    const worldDirection = direction.clone().applyQuaternion(cadQuaternion);
    // Faces have a defined up direction; edges and corners keep CAD Z up.
    const worldUp = up
      ? up.clone().applyQuaternion(cadQuaternion)
      : new THREE.Vector3(0, 0, 1).applyQuaternion(cadQuaternion);
    onView(worldDirection, worldUp);
  };
  const onPointerLeave = () => {
    if (!drag) setHovered(null);
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerLeave);

  const render = () => {
    const main = controls.object;
    camera.quaternion.copy(main.quaternion);
    camera.position.set(0, 0, 8).applyQuaternion(main.quaternion);
    camera.updateMatrixWorld();
    light.position.copy(camera.position).add(new THREE.Vector3(1, 2, 0).applyQuaternion(main.quaternion));
    renderer.render(scene, camera);
  };

  const dispose = () => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointerleave", onPointerLeave);
    scene.traverse((object) => {
      object.geometry?.dispose();
      if (object.material) {
        object.material.map?.dispose();
        object.material.dispose();
      }
    });
    renderer.dispose();
    canvas.remove();
  };

  return { domElement: canvas, render, dispose };
}
