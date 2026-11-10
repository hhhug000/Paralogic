import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import { FontLoader } from "three/examples/jsm/loaders/FontLoader.js";
import { TextGeometry } from "three/examples/jsm/geometries/TextGeometry.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { MeshBVH, acceleratedRaycast } from "three-mesh-bvh";
import helvetikerFont from "three/examples/fonts/helvetiker_regular.typeface.json";
import { CadControls, MOUSE_PRESETS } from "./cadControls.js";
import {
  EDGE_LINE,
  createTopology,
  decodeMesh,
  describePick,
  segmentDistanceSq,
} from "./mesh.js";
import { createSilhouette } from "./silhouette.js";
import { createViewCube } from "./viewCube.js";
import "./styles.css";

// The model starts empty; features are added to this list.
const initialFeatures = [];

const SELECT_COLOR = 0xf28c28;
const HOVER_COLOR = 0xffc078;
// Dark theme: the viewport background, model edges drawn on shaded faces, and
// lighter edges for the line-only display modes.
const BACKGROUND_COLOR = 0x393b3d;
const EDGE_COLOR = 0x1d2329;
const LINE_MODE_EDGE_COLOR = 0xd5dbe0;
const SECTION_COLOR = 0xc96a5a;
const MEASURE_COLOR = 0x1f6fb2;

// Picking tolerances and marker size, in screen pixels, so picking feels the
// same at every zoom level.
const VERTEX_PICK_PX = 10;
const EDGE_PICK_PX = 7;
const MARKER_PX = 14;
// Pixel offsets tried, nearest first, when the pointer is just off the model.
const PICK_RING = [4, VERTEX_PICK_PX].flatMap((radius) =>
  [...Array(8).keys()].map((i) => [
    Math.round(radius * Math.cos((i * Math.PI) / 4)),
    Math.round(radius * Math.sin((i * Math.PI) / 4)),
  ]),
);

const MODEL_COLOR = 0xb3c2ce;
const BASE_COLOR = new THREE.Color(MODEL_COLOR);
const HOVER_TINT = new THREE.Color(MODEL_COLOR).lerp(new THREE.Color(HOVER_COLOR), 0.35);
const SELECT_TINT = new THREE.Color(MODEL_COLOR).lerp(new THREE.Color(SELECT_COLOR), 0.6);

export const DISPLAY_MODES = {
  "shaded-edges": "Shaded with edges",
  shaded: "Shaded",
  "hidden-line": "Hidden line",
  wireframe: "Wireframe",
  transparent: "Transparent",
};

// Standard views in Three.js world coordinates, where CAD Z is screen up and
// CAD -Y (the front) faces +Z. `direction` points from the model to the camera.
const STANDARD_VIEWS = {
  front: { label: "Front", key: "1", direction: [0, 0, 1], up: [0, 1, 0] },
  back: { label: "Back", key: "2", direction: [0, 0, -1], up: [0, 1, 0] },
  left: { label: "Left", key: "3", direction: [-1, 0, 0], up: [0, 1, 0] },
  right: { label: "Right", key: "4", direction: [1, 0, 0], up: [0, 1, 0] },
  top: { label: "Top", key: "5", direction: [0, 1, 0], up: [0, 0, -1] },
  bottom: { label: "Bottom", key: "6", direction: [0, -1, 0], up: [0, 0, 1] },
  isometric: { label: "Isometric", key: "7", direction: [1, 1, 1], up: [0, 1, 0] },
  dimetric: { label: "Dimetric", direction: [1, 1.35, 1], up: [0, 1, 0] },
  trimetric: { label: "Trimetric", direction: [1.2, 1, 0.8], up: [0, 1, 0] },
};

const SECTION_AXES = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };

// Datum planes in CAD coordinates. Each normal points towards the standard
// view that looks straight at the plane, matching the builder's Plane.XY,
// Plane.XZ and Plane.YZ.
const PLANE_SIZE = 150;
const DATUM_PLANES = {
  XY: { label: "Top", normal: [0, 0, 1], rotation: new THREE.Euler(0, 0, 0) },
  XZ: { label: "Front", normal: [0, -1, 0], rotation: new THREE.Euler(Math.PI / 2, 0, 0) },
  YZ: { label: "Right", normal: [1, 0, 0], rotation: new THREE.Euler(Math.PI / 2, 0, Math.PI / 2, "ZYX") },
};
const PLANE_STYLES = {
  base: { fill: 0xffffff, opacity: 0.035, outline: 0xb9bdc1 },
  hover: { fill: HOVER_COLOR, opacity: 0.06, outline: HOVER_COLOR },
  selected: { fill: SELECT_COLOR, opacity: 0.1, outline: SELECT_COLOR },
};

// Per-viewer preferences survive reloads; storage can be unavailable.
function loadSetting(name, fallback, allowed) {
  try {
    const value = localStorage.getItem(`paralogic.${name}`);
    return value !== null && (!allowed || allowed.includes(value)) ? value : fallback;
  } catch {
    return fallback;
  }
}

function saveSetting(name, value) {
  try {
    localStorage.setItem(`paralogic.${name}`, value);
  } catch {
    // Settings simply do not persist.
  }
}

function usePersistentState(name, fallback, allowed) {
  const [value, setValue] = useState(() => loadSetting(name, fallback, allowed));
  useEffect(() => saveSetting(name, value), [name, value]);
  return [value, setValue];
}

// Disposes an object and everything below it. Geometry or textures shared with
// other objects are flagged in userData and left alone.
function disposeObject(object) {
  object.traverse((child) => {
    if (!child.userData.sharedGeometry) child.geometry?.dispose();
    const materials = Array.isArray(child.material)
      ? child.material
      : child.material
        ? [child.material]
        : [];
    materials.forEach((material) => {
      if (material.map && !material.map.userData.shared) material.map.dispose();
      if (!material.userData.shared) material.dispose();
    });
  });
}

function clearGroup(group) {
  while (group.children.length) {
    const child = group.children.pop();
    disposeObject(child);
  }
}

// Shortcuts are ignored while typing. A focused button only keeps Space and
// Enter (its own activation keys), so hotkeys work right after using the
// toolbar.
function isTyping(event) {
  if (event.target.closest?.("input, textarea, select, [contenteditable]")) return true;
  return (event.key === " " || event.key === "Enter") && Boolean(event.target.closest?.("button"));
}

// Arrows around the view cube: triangles to orbit, curved arrows to roll.
function GizmoArrow({ kind, position }) {
  if (kind === "roll") {
    const mirrored = position === "roll-right";
    return (
      <svg width="34" height="22" viewBox="0 0 34 22" aria-hidden="true">
        <g transform={mirrored ? "translate(34 0) scale(-1 1)" : undefined}>
          <path d="M30 17C24 7 15 5 7 9" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
          <path d="M2 11.5 9.5 4.5l1.6 9.6z" fill="currentColor" />
        </g>
      </svg>
    );
  }
  const rotation = { up: 0, right: 90, down: 180, left: 270 }[position];
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M7 2 13 12H1z" fill="currentColor" transform={`rotate(${rotation} 7 7)`} />
    </svg>
  );
}

function Viewport({ mesh, measurement, onPick, apiRef, children }) {
  // These refs point to objects that must survive React renders without causing
  // the Three.js scene to be rebuilt every time the UI changes.
  const mount = useRef(null);
  const originMarker = useRef(null);
  const pivotMarker = useRef(null);
  const tooltip = useRef(null);
  const cubeMount = useRef(null);
  const dimensionLabel = useRef(null);
  const sceneRef = useRef(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  const [display, setDisplay] = usePersistentState(
    "display",
    "shaded-edges",
    Object.keys(DISPLAY_MODES),
  );
  const [projection, setProjection] = usePersistentState("projection", "perspective", [
    "perspective",
    "orthographic",
  ]);
  const [rotationMode, setRotationMode] = usePersistentState("rotation", "turntable", [
    "turntable",
    "trackball",
  ]);
  const [mousePreset, setMousePreset] = usePersistentState(
    "mouse",
    "paralogic",
    Object.keys(MOUSE_PRESETS),
  );
  const [showPlanes, setShowPlanes] = usePersistentState("planes", "on", ["on", "off"]);
  const [section, setSection] = useState({ enabled: false, plane: "XZ", offset: 0, flip: false });
  const [sectionRange, setSectionRange] = useState({ XY: [-10, 10], XZ: [-10, 10], YZ: [-10, 10] });
  const [menu, setMenu] = useState(null);

  useEffect(() => {
    const container = mount.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BACKGROUND_COLOR);
    // Three.js and the view cube are Y-up, while build123d is Z-up. All CAD
    // content lives in this group, which maps CAD Z to screen up, so CAD XY is
    // the Top plane, XZ the Front plane, and YZ the Right plane.
    const cadRoot = new THREE.Group();
    cadRoot.rotation.x = -Math.PI / 2;
    cadRoot.updateMatrixWorld();
    scene.add(cadRoot);

    const perspective = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
    perspective.position.set(80, 70, 80);
    perspective.lookAt(0, 0, 0);
    const orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.localClippingEnabled = true;
    container.appendChild(renderer.domElement);

    // Selection and hover graphics live in separate groups so they can be
    // cleared without changing the actual compiled model.
    const selection = new THREE.Group();
    cadRoot.add(selection);
    const hoverSelection = new THREE.Group();
    cadRoot.add(hoverSelection);
    const dimension = new THREE.Group();
    cadRoot.add(dimension);

    // Soft ambient light plus a headlight that follows the camera, so faces
    // turned towards the viewer are always readable.
    scene.add(new THREE.HemisphereLight(0xffffff, 0xaaaaaa, 1.2));
    const headlight = new THREE.DirectionalLight(0xffffff, 1.6);
    scene.add(headlight, headlight.target);

    // Reference planes, in CAD coordinates. Each rotation keeps the label
    // readable when the plane is viewed from its standard direction.
    const planeFont = new FontLoader().parse(helvetikerFont);
    const referencePlanes = new THREE.Group();
    cadRoot.add(referencePlanes);
    const datumPlanes = {};
    Object.entries(DATUM_PLANES).forEach(([name, { label, rotation }]) => {
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE),
        new THREE.MeshBasicMaterial({
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      plane.userData.plane = name;
      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(plane.geometry),
        new THREE.LineBasicMaterial({ transparent: true, opacity: 0.82 }),
      );
      // Labels use real 3D text so they rotate and can be occluded.
      const text = new THREE.Mesh(
        new TextGeometry(label, { font: planeFont, size: 4, depth: 0.08, curveSegments: 4 }),
        new THREE.MeshBasicMaterial({ color: 0xdfe2e5, side: THREE.DoubleSide, depthWrite: false }),
      );
      text.position.set(-70, 68, 0.12);
      text.renderOrder = 4;
      const group = new THREE.Group();
      group.add(plane, outline, text);
      group.rotation.copy(rotation);
      referencePlanes.add(group);
      datumPlanes[name] = { plane, outline };
    });
    const styleDatumPlane = (name, style) => {
      const { plane, outline } = datumPlanes[name];
      plane.material.color.set(style.fill);
      plane.material.opacity = style.opacity;
      outline.material.color.set(style.outline);
    };
    Object.keys(datumPlanes).forEach((name) => styleDatumPlane(name, PLANE_STYLES.base));

    // Shared materials. Faces are pushed back slightly in depth so edges drawn
    // exactly on them never flicker.
    const faceOffset = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
    const materials = {
      shaded: new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.6,
        metalness: 0.05,
        ...faceOffset,
      }),
      // Faces in the background colour hide what is behind them, leaving a
      // line drawing.
      hiddenLine: new THREE.MeshBasicMaterial({ color: BACKGROUND_COLOR, ...faceOffset }),
      // Not drawn, but the model stays raycastable for picking.
      invisible: new THREE.MeshBasicMaterial({ visible: false }),
      transparent: new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.6,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      // Back faces only become visible through a section cut, where they
      // read as the cut surface.
      cap: new THREE.MeshBasicMaterial({ color: SECTION_COLOR, side: THREE.BackSide }),
      edges: new THREE.LineBasicMaterial({ color: EDGE_COLOR }),
      silhouette: new THREE.LineBasicMaterial({ color: EDGE_COLOR }),
    };
    // The section plane clips the model and its overlays, but not the
    // reference planes. All clipped materials share this one array.
    const clipPlanes = [];
    const clippedMaterials = new Set();
    const clip = (material) => {
      material.clippingPlanes = clipPlanes;
      clippedMaterials.add(material);
      material.addEventListener("dispose", () => clippedMaterials.delete(material));
      return material;
    };
    Object.values(materials).forEach((material) => {
      material.userData.shared = true;
      clip(material);
    });

    const state = {
      cadRoot,
      model: null,
      cap: null,
      edgeLines: null,
      silhouette: null,
      topology: null,
      hasFitted: false,
      display: "shaded-edges",
      sectionPlane: null,
      cameraKey: "",
    };

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const size = new THREE.Vector2(1, 1);
    // First intersection that is not cut away by the section plane.
    const firstVisibleHit = (caster = raycaster) => {
      if (!state.model) return null;
      if (!state.sectionPlane) {
        caster.firstHitOnly = true;
        return caster.intersectObject(state.model, false)[0] || null;
      }
      caster.firstHitOnly = false;
      return (
        caster
          .intersectObject(state.model, false)
          .find((hit) => state.sectionPlane.distanceToPoint(hit.point) >= 0) || null
      );
    };
    const castAt = (clientX, clientY) => {
      const bounds = container.getBoundingClientRect();
      pointer.set(
        ((clientX - bounds.left) / bounds.width) * 2 - 1,
        -((clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      controls.sync();
      raycaster.setFromCamera(pointer, controls.object);
      return firstVisibleHit();
    };

    const controls = new CadControls(perspective, orthographic, renderer.domElement, {
      pickPoint: (clientX, clientY) => castAt(clientX, clientY)?.point.clone() || null,
    });

    // Clicking a face, edge or corner of the cube turns the view to look from
    // that direction; dragging it orbits.
    const viewCube = createViewCube({
      controls,
      cadQuaternion: cadRoot.quaternion,
      onView: (direction, up) => orientTo(direction, up),
    });
    cubeMount.current.appendChild(viewCube.domElement);

    // --- Camera commands ---------------------------------------------------
    const modelSphere = () => {
      if (!state.model) return null;
      const geometry = state.model.geometry;
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const sphere = geometry.boundingSphere.clone();
      sphere.center.applyMatrix4(state.model.matrixWorld);
      return sphere;
    };
    const fitDistance = (radius) => {
      const vertical = THREE.MathUtils.degToRad(perspective.fov / 2);
      const horizontal = Math.atan(Math.tan(vertical) * perspective.aspect);
      return Math.max((radius / Math.sin(Math.min(vertical, horizontal))) * 1.1, 1);
    };
    const currentDirection = () =>
      controls.object.position.clone().sub(controls.target).normalize();
    const currentUp = () => new THREE.Vector3(0, 1, 0).applyQuaternion(controls.object.quaternion);

    const frameSphere = (sphere, animate = true) => {
      if (!sphere) return;
      const distance = fitDistance(Math.max(sphere.radius, 0.5));
      if (animate) {
        controls.animateTo({
          target: sphere.center,
          direction: currentDirection(),
          up: currentUp(),
          distance,
        });
      } else {
        const direction = currentDirection();
        controls.target.copy(sphere.center);
        controls.object.position.copy(sphere.center).addScaledVector(direction, distance);
        controls.changed();
      }
    };
    // Without a model, fitting frames the datum planes.
    const datumSphere = () =>
      new THREE.Sphere(new THREE.Vector3(), (PLANE_SIZE / 2) * Math.SQRT2 * 0.8);
    const fit = (animate = true) => frameSphere(modelSphere() || datumSphere(), animate);

    // Turns to a view direction and, in the same animation, centres and fits
    // the model (or the datum planes when there is none), so the result is the
    // standard position wherever the camera was before.
    const orientTo = (direction, up) => {
      const sphere = modelSphere() || datumSphere();
      controls.animateTo({
        target: sphere.center,
        direction,
        up,
        distance: fitDistance(Math.max(sphere.radius, 0.5)),
      });
    };
    const setView = (name) => {
      const view = STANDARD_VIEWS[name];
      if (!view) return;
      orientTo(new THREE.Vector3(...view.direction), new THREE.Vector3(...view.up));
    };

    // Points (in world coordinates) covered by the current selection.
    const selectionPoints = () => {
      const { topology } = state;
      const points = [];
      const point = new THREE.Vector3();
      for (const { picked } of selected.values()) {
        if (picked.kind === "origin") points.push(new THREE.Vector3());
        else if (picked.kind === "plane") {
          const half = PLANE_SIZE / 2;
          const corners = [[-half, -half], [half, -half], [half, half], [-half, half]];
          const rotation = new THREE.Matrix4().makeRotationFromEuler(DATUM_PLANES[picked.id].rotation);
          corners.forEach(([u, v]) => points.push(new THREE.Vector3(u, v, 0).applyMatrix4(rotation)));
        } else if (picked.kind === "vertex") points.push(topology.vertexPoint(picked.id, point).clone());
        else if (picked.kind === "midpoint") points.push(topology.midpoint(picked.id, point).clone());
        else if (picked.kind === "edge") {
          for (let i = 0; i < topology.edgePointCount(picked.id); i += 1) {
            points.push(topology.edgePoint(picked.id, i, point).clone());
          }
        } else {
          const [start, end] = topology.faceVertexRange(picked.id);
          const positions = state.model.geometry.attributes.position;
          for (let vertex = start; vertex < end; vertex += 1) {
            points.push(new THREE.Vector3().fromBufferAttribute(positions, vertex));
          }
        }
      }
      return points.map((p) => p.applyMatrix4(cadRoot.matrixWorld));
    };
    const zoomToSelection = () => {
      const points = selectionPoints();
      if (!points.length) {
        fit();
        return;
      }
      const sphere = new THREE.Sphere().setFromPoints(points);
      frameSphere(sphere);
    };

    // Looks straight at the selected (or hovered) face or datum plane.
    // Repeating it on the same one flips to the other side, as in other CAD
    // systems.
    const normalTo = () => {
      const planar = [...selected.values()]
        .map(({ picked }) => picked)
        .filter((picked) => picked.kind === "face" || picked.kind === "plane");
      const target =
        planar[planar.length - 1] ||
        (hovered?.kind === "face" || hovered?.kind === "plane" ? hovered : null);
      if (!target) return false;
      if (target.kind === "plane") {
        const normal = new THREE.Vector3(...DATUM_PLANES[target.id].normal);
        return lookAlong(normal, new THREE.Vector3());
      }
      if (!state.model) return false;
      const face = target.id;
      const geometry = state.model.geometry;
      const positions = geometry.attributes.position;
      const index = geometry.index;
      const [first, last] = state.topology.faceTriangleRange(face);
      const normal = new THREE.Vector3();
      const center = new THREE.Vector3();
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const c = new THREE.Vector3();
      const triangle = new THREE.Triangle();
      let area = 0;
      for (let t = first; t < last; t += 1) {
        a.fromBufferAttribute(positions, index.getX(t * 3));
        b.fromBufferAttribute(positions, index.getX(t * 3 + 1));
        c.fromBufferAttribute(positions, index.getX(t * 3 + 2));
        triangle.set(a, b, c);
        const triangleArea = triangle.getArea();
        normal.addScaledVector(triangle.getNormal(new THREE.Vector3()), triangleArea);
        center.addScaledVector(triangle.getMidpoint(new THREE.Vector3()), triangleArea);
        area += triangleArea;
      }
      if (area === 0 || normal.lengthSq() < 1e-12) return false;
      return lookAlong(normal.normalize(), center.divideScalar(area));
    };
    // Points the camera along a CAD-space normal at a CAD-space center.
    const lookAlong = (cadNormal, cadCenter) => {
      const center = cadCenter.clone().applyMatrix4(cadRoot.matrixWorld);
      const normal = cadNormal.clone().applyQuaternion(cadRoot.quaternion);
      if (currentDirection().dot(normal) > 0.9999) normal.negate();
      // Screen-up snaps to the model axis (CAD ±X, ±Y, ±Z) lying in the face
      // that is closest to the current screen-up, so the result is square to
      // the model and the view rolls as little as possible.
      const screenUp = currentUp();
      let up = null;
      let bestAlignment = -Infinity;
      for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
        for (const sign of [1, -1]) {
          const candidate = new THREE.Vector3(...axis)
            .multiplyScalar(sign)
            .applyQuaternion(cadRoot.quaternion)
            .projectOnPlane(normal);
          if (candidate.lengthSq() < 0.25) continue;
          const alignment = candidate.normalize().dot(screenUp);
          if (alignment > bestAlignment) {
            bestAlignment = alignment;
            up = candidate;
          }
        }
      }
      if (!up) up = screenUp.projectOnPlane(normal).normalize();
      controls.animateTo({ target: center, direction: normal, up });
      return true;
    };

    // --- Rendering helpers -------------------------------------------------
    const lineMaterials = new Set();
    const markers = new Set();
    // Sprites with sizeAttenuation off are sized relative to the viewport
    // height, so this converts a pixel diameter to sprite scale.
    // In orthographic view the scale is simply in world units.
    const markerScale = () =>
      controls.projection === "orthographic"
        ? (MARKER_PX * (orthographic.top - orthographic.bottom)) / size.y
        : (MARKER_PX * 2 * Math.tan(THREE.MathUtils.degToRad(perspective.fov / 2))) / size.y;
    const resize = () => {
      const { width, height } = container.getBoundingClientRect();
      size.set(Math.max(width, 1), Math.max(height, 1));
      perspective.aspect = size.x / size.y;
      perspective.updateProjectionMatrix();
      controls.sync();
      renderer.setSize(size.x, size.y);
      lineMaterials.forEach((material) => material.resolution.copy(size));
      state.cameraKey = "";
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    const markerTexture = (outlineColor, fillColor) => {
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      const context = canvas.getContext("2d");
      const color = (value) => `#${value.toString(16).padStart(6, "0")}`;
      context.beginPath();
      context.arc(16, 16, 11, 0, Math.PI * 2);
      if (fillColor !== null) {
        context.fillStyle = color(fillColor);
        context.globalAlpha = 0.7;
        context.fill();
        context.globalAlpha = 1;
      }
      context.strokeStyle = color(outlineColor);
      context.lineWidth = 3;
      context.stroke();
      const texture = new THREE.CanvasTexture(canvas);
      texture.userData.shared = true;
      return texture;
    };
    const textures = {
      hover: markerTexture(HOVER_COLOR, null),
      selected: markerTexture(SELECT_COLOR, HOVER_COLOR),
      measure: markerTexture(MEASURE_COLOR, 0xffffff),
    };
    // Markers are drawn on top and hidden by an occlusion raycast instead of
    // the depth test, so a vertex is never half buried in its own faces.
    const createVertexMarker = (position, texture) => {
      const marker = new THREE.Sprite(
        clip(
          new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
            sizeAttenuation: false,
          }),
        ),
      );
      marker.position.copy(position);
      marker.scale.setScalar(markerScale());
      marker.renderOrder = 20;
      markers.add(marker);
      marker.material.addEventListener("dispose", () => markers.delete(marker));
      state.cameraKey = "";
      return marker;
    };
    // WebGL ignores LineBasicMaterial.linewidth on most platforms, so wide
    // lines use LineSegments2, which draws them as screen-space quads.
    const createThickLines = (positions, color, width, dashed = false) => {
      const lineGeometry = new LineSegmentsGeometry();
      lineGeometry.setPositions(positions);
      // Overlay lines test depth so hidden edges stay hidden, but do not
      // write it, so a hover outline and a selection outline on the same edge
      // never fight each other.
      const lineMaterial = clip(
        new LineMaterial({
          color,
          linewidth: width,
          dashed,
          dashSize: 1,
          gapSize: 0.6,
          transparent: true,
          depthWrite: false,
          // Wide lines are drawn as triangles; pulling them towards the camera
          // stops them flickering against the face they lie on.
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -4,
        }),
      );
      lineMaterial.resolution.copy(size);
      lineMaterials.add(lineMaterial);
      lineMaterial.addEventListener("dispose", () => lineMaterials.delete(lineMaterial));
      const lines = new LineSegments2(lineGeometry, lineMaterial);
      if (dashed) lines.computeLineDistances();
      lines.renderOrder = 20;
      return lines;
    };
    // Builds the line or marker highlight for a picked item. Faces are also
    // tinted through the model's vertex colors (see paintFace).
    const createOverlay = (picked, isSelected) => {
      const { topology } = state;
      const color = isSelected ? SELECT_COLOR : HOVER_COLOR;
      const width = isSelected ? 3 : 2.5;
      const point = new THREE.Vector3();
      const texture = isSelected ? textures.selected : textures.hover;
      // Datum planes are highlighted by restyling them (see paintItem); the
      // empty group only marks their place in the selection.
      if (picked.kind === "plane") return new THREE.Group();
      if (picked.kind === "origin") return createVertexMarker(point.set(0, 0, 0), texture);
      if (picked.kind === "vertex") {
        return createVertexMarker(topology.vertexPoint(picked.id, point), texture);
      }
      if (picked.kind === "midpoint") {
        return createVertexMarker(topology.midpoint(picked.id, point), texture);
      }
      const edges = picked.kind === "edge" ? [picked.id] : topology.faceEdges(picked.id);
      return createThickLines(topology.segments(edges), color, width);
    };

    // --- Selection and hover -----------------------------------------------
    const selected = new Map();
    let hovered = null;
    // Faces are highlighted by recolouring their own vertex range, which costs
    // no extra geometry or draw calls and respects depth like the model does.
    const paintFace = (face) => {
      const colors = state.model?.geometry.attributes.color;
      if (!colors) return;
      const tint = selected.has(`face:${face}`)
        ? SELECT_TINT
        : hovered?.key === `face:${face}`
          ? HOVER_TINT
          : BASE_COLOR;
      const [start, end] = state.topology.faceVertexRange(face);
      for (let vertex = start; vertex < end; vertex += 1) {
        colors.setXYZ(vertex, tint.r, tint.g, tint.b);
      }
      colors.addUpdateRange(start * 3, (end - start) * 3);
      colors.needsUpdate = true;
    };
    const paintPlane = (name) => {
      const key = `plane:${name}`;
      styleDatumPlane(
        name,
        selected.has(key) ? PLANE_STYLES.selected : hovered?.key === key ? PLANE_STYLES.hover : PLANE_STYLES.base,
      );
    };
    const paintItem = (picked) => {
      if (picked?.kind === "face") paintFace(picked.id);
      else if (picked?.kind === "plane") paintPlane(picked.id);
    };
    const reportSelection = () =>
      onPickRef.current([...selected.values()].map(({ picked }) => picked));
    const clearSelection = () => {
      const items = [...selected.values()].map(({ picked }) => picked);
      selected.clear();
      clearGroup(selection);
      items.forEach(paintItem);
      reportSelection();
    };
    const hideTooltip = () => {
      if (tooltip.current) tooltip.current.style.display = "none";
    };
    const clearHover = () => {
      const previous = hovered;
      hovered = null;
      clearGroup(hoverSelection);
      hideTooltip();
      paintItem(previous);
    };

    const projected = new THREE.Vector3();
    // Projects a point in CAD coordinates to viewport pixels.
    const toScreen = (point) => {
      projected.copy(point).applyMatrix4(cadRoot.matrixWorld).project(controls.object);
      return [(projected.x * 0.5 + 0.5) * size.x, (-projected.y * 0.5 + 0.5) * size.y];
    };
    // Raycasts to find the visible CAD face, then only tests that face's own
    // boundary edges and vertices, in screen pixels. Hidden edges and vertices
    // can never be picked, and the work is independent of model size.
    // Priority, as in other CAD systems: a vertex or edge of the model, then
    // the origin, then a model face, then a datum plane.
    const pick = (event) => {
      const bounds = container.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      const modelPick = pickModel(event, x, y);
      if (modelPick && modelPick.kind !== "face") return modelPick;
      const [ox, oy] = toScreen(new THREE.Vector3());
      if ((ox - x) ** 2 + (oy - y) ** 2 < VERTEX_PICK_PX * VERTEX_PICK_PX) {
        return { kind: "origin", id: 0, key: "origin:0" };
      }
      if (modelPick) return modelPick;
      return pickDatumPlane(event);
    };
    const planeRaycaster = new THREE.Raycaster();
    const pickDatumPlane = (event) => {
      if (!referencePlanes.visible) return null;
      const bounds = container.getBoundingClientRect();
      pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      planeRaycaster.setFromCamera(pointer, controls.object);
      const hit = planeRaycaster.intersectObjects(
        Object.values(datumPlanes).map(({ plane }) => plane),
        false,
      )[0];
      if (!hit) return null;
      const name = hit.object.userData.plane;
      return { kind: "plane", id: name, key: `plane:${name}` };
    };
    const pickModel = (event, x, y) => {
      if (!state.model) return null;
      let hit = castAt(event.clientX, event.clientY);
      // Just outside the silhouette the ray misses the model, but an outline
      // edge or corner may still be within tolerance. Nearby rays find the
      // face it belongs to; with a BVH each extra ray is a few microseconds.
      const onModel = Boolean(hit);
      for (let i = 0; !hit && i < PICK_RING.length; i += 1) {
        hit = castAt(event.clientX + PICK_RING[i][0], event.clientY + PICK_RING[i][1]);
      }
      if (!hit || hit.faceIndex == null) return null;
      const { topology } = state;
      const face = topology.faceOfTriangle[hit.faceIndex];
      const edges = topology.faceEdges(face);
      const point = new THREE.Vector3();

      let best = null;
      let bestDistance = VERTEX_PICK_PX * VERTEX_PICK_PX;
      const tryPoint = (kind, id, position) => {
        const [sx, sy] = toScreen(position);
        const distance = (sx - x) ** 2 + (sy - y) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { kind, id, key: `${kind}:${id}` };
        }
      };
      const seenVertices = new Set();
      for (const edge of edges) {
        for (const vertex of topology.edgeVertices(edge)) {
          if (seenVertices.has(vertex)) continue;
          seenVertices.add(vertex);
          tryPoint("vertex", vertex, topology.vertexPoint(vertex, point));
        }
        if (topology.edgeKind(edge) === EDGE_LINE) {
          tryPoint("midpoint", edge, topology.midpoint(edge, point));
        }
      }
      if (best) return best;

      bestDistance = EDGE_PICK_PX * EDGE_PICK_PX;
      for (const edge of edges) {
        let [ax, ay] = toScreen(topology.edgePoint(edge, 0, point));
        for (let i = 1; i < topology.edgePointCount(edge); i += 1) {
          const [bx, by] = toScreen(topology.edgePoint(edge, i, point));
          const distance = segmentDistanceSq(x, y, ax, ay, bx, by);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = { kind: "edge", id: edge, key: `edge:${edge}` };
          }
          ax = bx;
          ay = by;
        }
      }
      if (best) return best;
      return onModel ? { kind: "face", id: face, key: `face:${face}` } : null;
    };

    // Every click toggles the hit item so users can build a multi-selection
    // without modifier keys; clicking empty space clears the selection.
    let pointerDown = null;
    const pointerDownHandler = (event) => {
      pointerDown = { x: event.clientX, y: event.clientY };
      hideTooltip();
      setMenu(null);
    };
    const click = (event) => {
      if (
        event.button !== 0 ||
        (pointerDown &&
          Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 4)
      )
        return;
      const picked = pick(event);
      if (!picked) {
        if (selected.size) clearSelection();
        return;
      }
      toggle(picked);
    };
    // Adds the item to the selection, or removes it if already selected. Used
    // by viewport clicks and by the feature tree.
    const toggle = (picked) => {
      if (selected.has(picked.key)) {
        const { overlay } = selected.get(picked.key);
        selection.remove(overlay);
        disposeObject(overlay);
        selected.delete(picked.key);
      } else {
        const overlay = createOverlay(picked, true);
        selection.add(overlay);
        selected.set(picked.key, { picked, overlay });
      }
      paintItem(picked);
      reportSelection();
    };

    // Hover work is coalesced to one pick per frame, skipped while dragging,
    // and the overlay is only rebuilt when the hovered item changes.
    let hoverFrame = null;
    let lastPointer = null;
    const showTooltip = () => {
      const element = tooltip.current;
      if (!element || !hovered || !lastPointer) return;
      const bounds = container.getBoundingClientRect();
      element.textContent =
        hovered.kind === "plane"
          ? `${DATUM_PLANES[hovered.id].label} plane (${hovered.id})`
          : hovered.kind === "origin"
            ? "Origin (0, 0, 0)"
            : describePick(state.topology, hovered);
      element.style.display = "block";
      // Keep the tooltip inside the viewport, flipping it to the other side
      // of the pointer near the right and bottom edges.
      const x = lastPointer.clientX - bounds.left;
      const y = lastPointer.clientY - bounds.top;
      const { offsetWidth: width, offsetHeight: height } = element;
      element.style.left = `${x + 14 + width > size.x ? Math.max(x - 14 - width, 0) : x + 14}px`;
      element.style.top = `${y + 18 + height > size.y ? Math.max(y - 12 - height, 0) : y + 18}px`;
    };
    const updateHover = () => {
      hoverFrame = null;
      if (controls.dragging) return;
      const picked = lastPointer && pick(lastPointer);
      if (picked?.key !== hovered?.key) {
        clearHover();
        if (picked) {
          hovered = picked;
          hoverSelection.add(createOverlay(picked, false));
          paintItem(picked);
        }
      }
      showTooltip();
    };
    const scheduleHover = () => {
      if (lastPointer && hoverFrame === null) hoverFrame = requestAnimationFrame(updateHover);
    };
    const hover = (event) => {
      if (event.buttons !== 0) {
        if (hovered) clearHover();
        return;
      }
      lastPointer = { clientX: event.clientX, clientY: event.clientY };
      scheduleHover();
    };
    const leave = () => {
      lastPointer = null;
      clearHover();
    };
    controls.addEventListener("start", clearHover);

    // --- Measurement dimension ---------------------------------------------
    let dimensionPoints = null;
    const setMeasurement = (result) => {
      clearGroup(dimension);
      dimensionPoints = null;
      const distance = result?.distance;
      if (!distance) return;
      const from = new THREE.Vector3(...distance.from);
      const to = new THREE.Vector3(...distance.to);
      if (distance.value > 1e-9) {
        dimension.add(createThickLines([...distance.from, ...distance.to], MEASURE_COLOR, 2, true));
      }
      dimension.add(createVertexMarker(from, textures.measure));
      if (distance.value > 1e-9) dimension.add(createVertexMarker(to, textures.measure));
      dimensionPoints = { mid: from.clone().add(to).multiplyScalar(0.5), value: distance.value };
    };

    // --- Display and section ------------------------------------------------
    const capVisible = () =>
      Boolean(state.sectionPlane) && state.display !== "wireframe" && state.display !== "transparent";
    const applyDisplay = (mode) => {
      state.display = mode;
      if (state.model) {
        state.model.material = {
          "hidden-line": materials.hiddenLine,
          transparent: materials.transparent,
          wireframe: materials.invisible,
        }[mode] || materials.shaded;
        state.edgeLines.visible = mode !== "shaded";
        // Dark edges read on shaded faces; line-only modes need light ones.
        const lineMode = mode === "hidden-line" || mode === "wireframe" || mode === "transparent";
        const edgeColor = lineMode ? LINE_MODE_EDGE_COLOR : EDGE_COLOR;
        materials.edges.color.set(edgeColor);
        materials.silhouette.color.set(edgeColor);
        state.silhouette.lines.visible = mode !== "shaded";
        state.cap.visible = capVisible();
      }
      state.cameraKey = "";
    };
    // By default the half nearer the camera is removed, so the cut faces the
    // viewer; the side is chosen when the section or its plane changes, not
    // while orbiting. "Flip" keeps the other half.
    let sectionSide = { plane: null, sign: 1 };
    const applySection = ({ enabled, plane, offset, flip }) => {
      const wasEnabled = clipPlanes.length > 0;
      clipPlanes.length = 0;
      state.sectionPlane = null;
      if (enabled) {
        const axis = new THREE.Vector3(...SECTION_AXES[plane]).applyQuaternion(cadRoot.quaternion);
        if (!wasEnabled || sectionSide.plane !== plane) {
          sectionSide = { plane, sign: currentDirection().dot(axis) >= 0 ? -1 : 1 };
        }
        const point = new THREE.Vector3(...SECTION_AXES[plane])
          .multiplyScalar(offset)
          .applyMatrix4(cadRoot.matrixWorld);
        const normal = axis.multiplyScalar(sectionSide.sign * (flip ? -1 : 1));
        state.sectionPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point);
        clipPlanes.push(state.sectionPlane);
      }
      // Changing the number of planes changes the shader programs.
      if (wasEnabled !== clipPlanes.length > 0) {
        clippedMaterials.forEach((material) => {
          material.needsUpdate = true;
        });
      }
      if (state.cap) state.cap.visible = capVisible();
      state.cameraKey = "";
    };

    // --- Per-frame work -----------------------------------------------------
    let frame = null;
    const origin = new THREE.Vector3();
    const eye = new THREE.Vector3();
    const forward = new THREE.Vector3();
    const inverseRoot = new THREE.Matrix4();
    const occlusionRay = new THREE.Raycaster();
    occlusionRay.firstHitOnly = true;
    const placeLabel = (element, worldPoint) => {
      if (!element) return;
      const p = worldPoint.clone().project(controls.object);
      const visible = p.z >= -1 && p.z <= 1;
      element.style.display = visible ? "block" : "none";
      element.style.left = `${(p.x * 0.5 + 0.5) * size.x}px`;
      element.style.top = `${(-p.y * 0.5 + 0.5) * size.y}px`;
    };
    // Work that only depends on the camera: silhouettes, marker occlusion
    // and hover under a still pointer (for example while wheel zooming).
    const onCameraChange = () => {
      const camera = controls.object;
      inverseRoot.copy(cadRoot.matrixWorld).invert();
      if (state.silhouette?.lines.visible) {
        eye.copy(camera.position).applyMatrix4(inverseRoot);
        camera.getWorldDirection(forward).transformDirection(inverseRoot);
        state.silhouette.update(eye, forward, controls.projection === "orthographic");
      }
      const occlude = state.model && (state.display === "shaded-edges" || state.display === "shaded" || state.display === "hidden-line");
      const position = new THREE.Vector3();
      const scale = markerScale();
      markers.forEach((marker) => {
        marker.scale.setScalar(scale);
        if (!occlude) {
          marker.visible = true;
          return;
        }
        marker.getWorldPosition(position);
        let rayOrigin, direction, distance;
        camera.getWorldDirection(forward);
        if (controls.projection === "orthographic") {
          direction = forward.clone();
          rayOrigin = position.clone().addScaledVector(direction, -1e5);
          distance = 1e5;
        } else {
          rayOrigin = camera.position;
          direction = position.clone().sub(rayOrigin);
          distance = direction.length();
          direction.normalize();
        }
        occlusionRay.set(rayOrigin, direction);
        const hit = firstVisibleHit(occlusionRay);
        marker.visible = !hit || hit.distance > distance - Math.max(distance * 1e-3, 1e-4);
      });
      scheduleHover();
    };
    const render = () => {
      controls.sync();
      const camera = controls.object;
      // Keep depth precision sensible for the current zoom level.
      const sphere = modelSphere();
      const distance = controls.distance();
      const extent = (sphere ? sphere.radius + camera.position.distanceTo(sphere.center) : 0) + 200;
      perspective.near = Math.max(distance / 1000, 0.01);
      perspective.far = Math.max(extent * 2, distance * 10);
      perspective.updateProjectionMatrix();
      orthographic.near = -extent * 2;
      orthographic.far = extent * 2;
      orthographic.updateProjectionMatrix();

      headlight.position.copy(camera.position);
      headlight.target.position.copy(controls.target);
      headlight.target.updateMatrixWorld();

      const key = `${controls.projection}|${camera.matrixWorld.elements.join(",")}|${size.x}x${size.y}`;
      if (key !== state.cameraKey) {
        state.cameraKey = key;
        onCameraChange();
      }
      renderer.render(scene, camera);

      origin.set(0, 0, 0);
      placeLabel(originMarker.current, origin);
      if (pivotMarker.current) {
        if (controls.pivot) placeLabel(pivotMarker.current, controls.pivot);
        else pivotMarker.current.style.display = "none";
      }
      if (dimensionLabel.current) {
        if (dimensionPoints && dimensionPoints.value > 1e-9) {
          placeLabel(dimensionLabel.current, dimensionPoints.mid.clone().applyMatrix4(cadRoot.matrixWorld));
          dimensionLabel.current.textContent = dimensionPoints.value.toFixed(3);
        } else {
          dimensionLabel.current.style.display = "none";
        }
      }
      viewCube.render();
      frame = requestAnimationFrame(render);
    };

    // --- Keyboard ------------------------------------------------------------
    const keyDown = (event) => {
      if (isTyping(event) || event.ctrlKey || event.metaKey || event.altKey) return;
      const view = Object.entries(STANDARD_VIEWS).find(([, v]) => v.key === event.key);
      const actions = {
        f: () => fit(),
        z: () => zoomToSelection(),
        n: () => normalTo(),
        o: () => setProjection((value) => (value === "perspective" ? "orthographic" : "perspective")),
        d: () =>
          setDisplay((value) => {
            const modes = Object.keys(DISPLAY_MODES);
            return modes[(modes.indexOf(value) + 1) % modes.length];
          }),
        s: () => setSection((value) => ({ ...value, enabled: !value.enabled })),
        p: () => setShowPlanes((value) => (value === "on" ? "off" : "on")),
        " ": () => clearSelection(),
        Escape: () => {
          clearSelection();
          setMenu(null);
        },
      };
      const action = view ? () => setView(view[0]) : actions[event.key.length === 1 ? event.key.toLowerCase() : event.key];
      if (!action) return;
      event.preventDefault();
      action();
    };

    state.setModel = (model, parts) => {
      // Face, edge and vertex ids belong to one model, so the old selection
      // is dropped before the new model is installed.
      clearHover();
      clearSelection();
      setMeasurement(null);
      Object.assign(state, { model, ...parts });
      if (model) {
        applyDisplay(state.display);
        applySection(state.section || { enabled: false });
        if (!state.hasFitted) {
          state.hasFitted = true;
          fit(false);
        }
      }
      state.cameraKey = "";
    };
    state.materials = materials;
    state.controls = controls;
    state.referencePlanes = referencePlanes;
    state.applyDisplay = applyDisplay;
    state.applySection = applySection;
    state.setMeasurement = setMeasurement;
    state.actions = {
      fit,
      setView,
      zoomToSelection,
      normalTo,
      clearSelection,
      step: (kind, sign) => controls.stepRotate(kind, sign),
    };
    // Lets the feature tree select and highlight datums.
    const hoverItem = (picked) => {
      if (picked?.key === hovered?.key) return;
      clearHover();
      if (!picked) return;
      hovered = picked;
      hoverSelection.add(createOverlay(picked, false));
      paintItem(picked);
    };
    if (apiRef) apiRef.current = { toggle, hover: hoverItem };
    sceneRef.current = state;

    const element = renderer.domElement;
    element.addEventListener("pointerdown", pointerDownHandler);
    element.addEventListener("click", click);
    element.addEventListener("pointermove", hover);
    element.addEventListener("pointerleave", leave);
    window.addEventListener("keydown", keyDown);
    resize();
    fit(false);
    render();

    return () => {
      cancelAnimationFrame(frame);
      if (hoverFrame !== null) cancelAnimationFrame(hoverFrame);
      resizeObserver.disconnect();
      element.removeEventListener("pointerdown", pointerDownHandler);
      element.removeEventListener("click", click);
      element.removeEventListener("pointermove", hover);
      element.removeEventListener("pointerleave", leave);
      window.removeEventListener("keydown", keyDown);
      controls.dispose();
      container.removeChild(renderer.domElement);
      viewCube.dispose();
      disposeObject(scene);
      Object.values(materials).forEach((material) => material.dispose());
      Object.values(textures).forEach((texture) => texture.dispose());
      renderer.dispose();
      sceneRef.current = null;
      if (apiRef) apiRef.current = null;
    };
  }, []);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state || !mesh) return;
    // Convert the worker's binary arrays into a Three.js geometry. The model
    // keeps its real CAD coordinates so the origin and reference planes stay
    // meaningful. Vertices are not shared between CAD faces, so normals are
    // smooth within a face and sharp across face boundaries.
    const decoded = decodeMesh(mesh);
    const topology = createTopology(decoded.topology);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(decoded.vertices, 3));
    geometry.setIndex(new THREE.BufferAttribute(decoded.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const vertexCount = geometry.attributes.position.count;
    const colors = new Float32Array(vertexCount * 3);
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      BASE_COLOR.toArray(colors, vertex * 3);
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    // A bounding volume hierarchy makes each raycast logarithmic in the
    // triangle count. "indirect" keeps the index buffer in its original order,
    // which the triangle-to-face mapping depends on.
    geometry.boundsTree = new MeshBVH(geometry, { indirect: true });
    const object = new THREE.Mesh(geometry, state.materials.shaded);
    object.raycast = acceleratedRaycast;
    object.name = "compiled-model";

    const cap = new THREE.Mesh(geometry, state.materials.cap);
    cap.userData.sharedGeometry = true;
    cap.raycast = () => {};
    cap.visible = false;

    // The drawn edges are the real CAD edges, so tangent edges such as fillet
    // boundaries are shown too.
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(topology.segments(topology.visibleEdges), 3),
    );
    const edgeLines = new THREE.LineSegments(edgeGeometry, state.materials.edges);
    edgeLines.renderOrder = 2;
    const silhouette = createSilhouette(
      decoded.vertices,
      decoded.indices,
      topology,
      state.materials.silhouette,
    );
    const group = new THREE.Group();
    group.add(object, cap, edgeLines, silhouette.lines);
    state.cadRoot.add(group);
    state.setModel(object, { cap, edgeLines, silhouette, topology });

    // Section offsets are limited to the model's extent along each axis.
    const box = new THREE.Box3().setFromBufferAttribute(geometry.attributes.position);
    const pad = Math.max(box.getSize(new THREE.Vector3()).length() * 0.01, 0.01);
    setSectionRange({
      XY: [box.min.z - pad, box.max.z + pad],
      XZ: [box.min.y - pad, box.max.y + pad],
      YZ: [box.min.x - pad, box.max.x + pad],
    });
    return () => {
      if (sceneRef.current?.model === object) {
        sceneRef.current.setModel(null, { cap: null, edgeLines: null, silhouette: null, topology: null });
      }
      state.cadRoot.remove(group);
      disposeObject(group);
      geometry.boundsTree = null;
    };
  }, [mesh]);

  useEffect(() => sceneRef.current?.applyDisplay(display), [display, mesh]);
  useEffect(() => {
    const state = sceneRef.current;
    if (!state) return;
    state.section = section;
    state.applySection(section);
  }, [section, mesh]);
  useEffect(() => sceneRef.current?.controls.setProjection(projection), [projection]);
  useEffect(() => {
    if (sceneRef.current) sceneRef.current.controls.rotationMode = rotationMode;
  }, [rotationMode]);
  useEffect(() => sceneRef.current?.controls.setMousePreset(mousePreset), [mousePreset]);
  useEffect(() => {
    if (sceneRef.current) sceneRef.current.referencePlanes.visible = showPlanes === "on";
  }, [showPlanes]);
  useEffect(() => sceneRef.current?.setMeasurement(measurement), [measurement]);

  const actions = () => sceneRef.current?.actions || {};
  const toggleMenu = (name) => setMenu((value) => (value === name ? null : name));
  // Camera actions close the menu; settings leave it open while adjusting.
  const run = (action) => {
    action();
    setMenu(null);
  };
  const [rangeMin, rangeMax] = sectionRange[section.plane];

  return (
    <div className="viewport" ref={mount}>
      <div className="origin-marker" ref={originMarker} aria-hidden="true" />
      <div className="pivot-marker" ref={pivotMarker} aria-hidden="true" />
      <div className="dimension-label" ref={dimensionLabel} aria-hidden="true" />
      <div className="hover-tooltip" ref={tooltip} role="status" />
      {children}
      <div className="gizmo" onPointerDown={(event) => event.stopPropagation()}>
        <div className="gizmo-cube" ref={cubeMount} />
        {[
          ["roll", -1, "roll-left", "Roll the view counter-clockwise"],
          ["roll", 1, "roll-right", "Roll the view clockwise"],
          ["pitch", 1, "up", "Rotate up (90° from a standard view)"],
          ["pitch", -1, "down", "Rotate down (90° from a standard view)"],
          ["yaw", -1, "left", "Rotate left (90° from a standard view)"],
          ["yaw", 1, "right", "Rotate right (90° from a standard view)"],
        ].map(([kind, sign, position, label]) => (
          <button
            type="button"
            key={position}
            className={`gizmo-arrow gizmo-${position}`}
            aria-label={label}
            title={label}
            onClick={() => actions().step?.(kind, sign)}
          >
            <GizmoArrow kind={kind} position={position} />
          </button>
        ))}
        <button
          type="button"
          className={`view-tools-button${menu === "tools" ? " open" : ""}`}
          onClick={() => toggleMenu("tools")}
          aria-expanded={menu === "tools"}
          aria-label="View tools"
          title="View tools"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1.8 13.5 4.8v6.4L8 14.2 2.5 11.2V4.8z" fill="#c9ccd0" />
            <path d="M2.5 4.8 8 7.8l5.5-3M8 7.8v6.4" fill="none" stroke="#2b2c2e" strokeWidth="1" />
          </svg>
          <span aria-hidden="true">▾</span>
        </button>
        {menu === "tools" && (
          <div className="view-tools-menu">
            <section>
              <h3>Views</h3>
              <div className="view-grid">
                {Object.entries(STANDARD_VIEWS).map(([name, view]) => (
                  <button type="button" key={name} onClick={() => run(() => actions().setView?.(name))}>
                    {view.label}
                    {view.key && <kbd>{view.key}</kbd>}
                  </button>
                ))}
              </div>
            </section>
            <section>
              <h3>Camera</h3>
              <button type="button" onClick={() => run(() => actions().fit?.())}>
                Fit model <kbd>F</kbd>
              </button>
              <button type="button" onClick={() => run(() => actions().zoomToSelection?.())}>
                Zoom to selection <kbd>Z</kbd>
              </button>
              <button type="button" onClick={() => run(() => actions().normalTo?.())}>
                Normal to selection <kbd>N</kbd>
              </button>
              <div className="segmented" role="group" aria-label="Projection">
                {["perspective", "orthographic"].map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={projection === value ? "active" : ""}
                    onClick={() => setProjection(value)}
                  >
                    {value === "perspective" ? "Perspective" : "Orthographic"}
                  </button>
                ))}
              </div>
            </section>
            <section>
              <h3>
                Display <kbd>D</kbd>
              </h3>
              <select
                aria-label="Display mode"
                value={display}
                onChange={(event) => setDisplay(event.target.value)}
              >
                {Object.entries(DISPLAY_MODES).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <label className="check">
                <input
                  type="checkbox"
                  checked={showPlanes === "on"}
                  onChange={(event) => setShowPlanes(event.target.checked ? "on" : "off")}
                />
                Reference planes <kbd>P</kbd>
              </label>
            </section>
            <section>
              <h3>
                Section <kbd>S</kbd>
              </h3>
              <label className="check">
                <input
                  type="checkbox"
                  checked={section.enabled}
                  onChange={(event) =>
                    setSection((value) => ({ ...value, enabled: event.target.checked }))
                  }
                />
                Section view
              </label>
              <label>
                Plane
                <select
                  value={section.plane}
                  onChange={(event) =>
                    setSection((value) => ({ ...value, plane: event.target.value, offset: 0 }))
                  }
                >
                  <option value="XY">Top (XY)</option>
                  <option value="XZ">Front (XZ)</option>
                  <option value="YZ">Right (YZ)</option>
                </select>
              </label>
              <label>
                <span>
                  Offset <output>{section.offset.toFixed(2)}</output>
                </span>
                <input
                  type="range"
                  min={rangeMin}
                  max={rangeMax}
                  step={(rangeMax - rangeMin) / 400 || 0.01}
                  value={THREE.MathUtils.clamp(section.offset, rangeMin, rangeMax)}
                  onChange={(event) =>
                    setSection((value) => ({
                      ...value,
                      enabled: true,
                      offset: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={section.flip}
                  onChange={(event) =>
                    setSection((value) => ({ ...value, flip: event.target.checked }))
                  }
                />
                Flip side
              </label>
            </section>
            <section>
              <h3>Navigation</h3>
              <p className="menu-hint">
                Rotate about the point under the cursor, pan, and zoom to the cursor. Buttons
                depend on the mouse preset.
              </p>
              <label>
                Rotation
                <select value={rotationMode} onChange={(event) => setRotationMode(event.target.value)}>
                  <option value="turntable">Turntable (Z stays up)</option>
                  <option value="trackball">Trackball (free)</option>
                </select>
              </label>
              <label>
                Mouse
                <select value={mousePreset} onChange={(event) => setMousePreset(event.target.value)}>
                  {Object.entries(MOUSE_PRESETS).map(([value, preset]) => (
                    <option key={value} value={value}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
            </section>
            <section>
              <h3>Shortcuts</h3>
              <dl className="shortcut-list">
                {[
                  ["1–7", "Standard views"],
                  ["F", "Fit model"],
                  ["Z", "Zoom to selection"],
                  ["N", "Normal to"],
                  ["O", "Projection"],
                  ["D", "Display mode"],
                  ["S", "Section"],
                  ["P", "Planes"],
                  ["Esc", "Clear selection"],
                ].map(([key, label]) => (
                  <React.Fragment key={key}>
                    <dt>
                      <kbd>{key}</kbd>
                    </dt>
                    <dd>{label}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

// Reads a JSON API response, turning non-JSON failures (such as a proxy error
// when the Go server is not running) into a readable message.
async function readResult(response) {
  const text = await response.text();
  let result = null;
  try {
    result = JSON.parse(text);
  } catch {
    // Fall through to the generic message below.
  }
  if (!response.ok || !result?.success) {
    throw new Error(
      result?.error ||
        `Server responded with ${response.status} ${response.statusText}`.trim() +
          (response.status >= 500 ? " — is the Go server running?" : ""),
    );
  }
  return result;
}

async function post(path, body, signal) {
  try {
    return await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error("Could not reach the server — is the Go server running?");
  }
}

// Face and edge numbers are the builder's own, so "edge 5" can be used as
// edge_indices: [5] in a fillet or chamfer.
function selectionLabel({ kind, id }) {
  if (kind === "midpoint") return `midpoint of edge ${id}`;
  if (kind === "plane") return `${DATUM_PLANES[id].label} plane (${id})`;
  if (kind === "origin") return "origin";
  return `${kind} ${id}`;
}

const formatNumber = (value) => (Math.abs(value) < 5e-10 ? "0" : value.toFixed(3));
const formatPoint = (point) => `(${point.map(formatNumber).join(", ")})`;

function describeItem(item) {
  const parts = [selectionLabel(item)];
  if (item.type && item.kind !== "plane") parts.push(item.type);
  if (item.position) parts.push(formatPoint(item.position));
  if (item.radius) parts.push(`R ${formatNumber(item.radius)}`);
  if (item.length !== undefined) parts.push(`L ${formatNumber(item.length)}`);
  if (item.area !== undefined) parts.push(`A ${formatNumber(item.area)}`);
  if (item.normal) parts.push(`n ${formatPoint(item.normal)}`);
  return parts.join(" · ");
}

function MeasurePanel({ measurement, picked, pending }) {
  if (!picked.length) return null;
  return (
    <div className="measure" aria-live="polite">
      <h3>
        Selection <span>{picked.length}</span>
      </h3>
      <ul className="selection-list">
        {(measurement?.items || picked).map((item) => (
          <li key={`${item.kind}:${item.id}`}>{measurement ? describeItem(item) : selectionLabel(item)}</li>
        ))}
      </ul>
      {measurement?.distance && (
        <dl className="measure-results">
          <dt>Distance</dt>
          <dd>{formatNumber(measurement.distance.value)}</dd>
          <dt>ΔX ΔY ΔZ</dt>
          <dd>{measurement.distance.delta.map(formatNumber).join("  ")}</dd>
          {measurement.angle !== undefined && (
            <>
              <dt>Angle</dt>
              <dd>{formatNumber(measurement.angle)}°</dd>
            </>
          )}
        </dl>
      )}
      {pending && <p className="hint">Measuring…</p>}
    </div>
  );
}

// The datums every model starts with, in the order CAD systems list them.
const DEFAULT_GEOMETRY = [
  { kind: "origin", id: 0, key: "origin:0", label: "Origin" },
  ...["XY", "XZ", "YZ"].map((id) => ({
    kind: "plane",
    id,
    key: `plane:${id}`,
    label: DATUM_PLANES[id].label,
  })),
];

function Icon({ name }) {
  const common = { width: 16, height: 16, viewBox: "0 0 16 16", "aria-hidden": true, className: "icon" };
  const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinejoin: "round" };
  switch (name) {
    case "brand":
      return (
        <svg {...common} width="20" height="20">
          <path d="M8 1.5 14 5v6l-6 3.5L2 11V5z" {...stroke} strokeWidth="1.5" />
          <path d="M2 5l6 3.5L14 5M8 8.5v6" {...stroke} />
        </svg>
      );
    case "rebuild":
      return (
        <svg {...common}>
          <path d="M13 8a5 5 0 1 1-1.6-3.7" {...stroke} />
          <path d="M11.8 1.8v2.9H8.9" {...stroke} />
        </svg>
      );
    case "export":
      return (
        <svg {...common}>
          <path d="M8 2v8M5 7l3 3 3-3M3 12.5v1h10v-1" {...stroke} />
        </svg>
      );
    case "filter":
      return (
        <svg {...common}>
          <path d="M2 3h12l-4.5 5.5V13l-3-1.5V8.5z" {...stroke} />
        </svg>
      );
    case "part":
      return (
        <svg {...common} width="14" height="14">
          <path d="M2 5 8 2l6 3v6l-6 3-6-3z" {...stroke} fill="currentColor" fillOpacity="0.18" />
        </svg>
      );
    default:
      return null;
  }
}

function TreeIcon({ kind }) {
  const common = { width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": true };
  if (kind === "origin") {
    return (
      <svg {...common} className="tree-icon">
        <circle cx="7" cy="7" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M7 0.5v4M7 9.5v4M0.5 7h4M9.5 7h4" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    );
  }
  if (kind === "plane") {
    return (
      <svg {...common} className="tree-icon">
        <path d="M3.5 2.5h9l-2 9h-9z" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    );
  }
  if (kind === "folder") {
    return (
      <svg {...common} className="tree-icon">
        <path d="M1 3.5h4.5l1.2 1.5H13v6.5H1z" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    );
  }
  return (
    <svg {...common} className="tree-icon">
      <path d="M2 4.5 7 2l5 2.5v5L7 12 2 9.5z M2 4.5 7 7l5-2.5 M7 7v5" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

function FeatureTree({ features, parts, picked, selectedFeature, onSelectFeature, viewport }) {
  const [query, setQuery] = useState("");
  const [defaultsOpen, setDefaultsOpen] = usePersistentState("tree.defaults", "open", [
    "open",
    "closed",
  ]);
  const [partsOpen, setPartsOpen] = usePersistentState("tree.parts", "open", ["open", "closed"]);
  const selectedKeys = new Set(picked.map((item) => item.key));
  const search = query.trim().toLowerCase();
  const matches = (...texts) =>
    !search || texts.some((text) => String(text).toLowerCase().includes(search));
  const defaults = DEFAULT_GEOMETRY.filter((item) =>
    matches(item.label, item.kind, item.kind === "plane" ? item.id : ""),
  );
  const shownFeatures = features
    .map((feature, index) => ({ feature, index }))
    .filter(({ feature, index }) => matches(feature.id ?? `Feature ${index + 1}`, feature.type));
  // While filtering, groups with matches are shown open.
  const defaultsExpanded = search ? defaults.length > 0 : defaultsOpen === "open";
  const nothingMatches = search && !defaults.length && !shownFeatures.length;

  return (
    <nav className="feature-tree" aria-label="Feature tree">
      <label className="panel-filter">
        <Icon name="filter" />
        <input
          type="search"
          placeholder="Filter by name or type"
          aria-label="Filter features by name or type"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <h2 className="panel-header">Features ({DEFAULT_GEOMETRY.length + features.length})</h2>
      <div className="tree-scroll">
        {(!search || defaults.length > 0) && (
          <div className="tree-group">
            <button
              type="button"
              className="tree-group-header"
              aria-expanded={defaultsExpanded}
              onClick={() => setDefaultsOpen(defaultsOpen === "open" ? "closed" : "open")}
            >
              <span className="chevron" aria-hidden="true">
                {defaultsExpanded ? "▾" : "▸"}
              </span>
              Default geometry
            </button>
            {defaultsExpanded && (
              <ul className="tree-children">
                {defaults.map((item) => (
                  <li key={item.key}>
                    <button
                      type="button"
                      className={`tree-item${selectedKeys.has(item.key) ? " selected" : ""}`}
                      aria-pressed={selectedKeys.has(item.key)}
                      onClick={() => viewport.current?.toggle(item)}
                      onMouseEnter={() => viewport.current?.hover(item)}
                      onMouseLeave={() => viewport.current?.hover(null)}
                    >
                      <TreeIcon kind={item.kind} />
                      {item.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {shownFeatures.length > 0 && (
          <ul className="tree-features">
            {shownFeatures.map(({ feature, index }) => {
              const key = feature.id ?? `#${index}`;
              return (
                <li key={key}>
                  <button
                    type="button"
                    className={`tree-item${selectedFeature === key ? " selected" : ""}`}
                    onClick={() => onSelectFeature(key)}
                  >
                    <TreeIcon kind="feature" />
                    {feature.id || `Feature ${index + 1}`}
                    <small>{feature.type}</small>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {!search && !features.length && <p className="tree-empty">No features yet.</p>}
        {nothingMatches && <p className="tree-empty">Nothing matches “{query.trim()}”.</p>}
      </div>
      <div className="panel-section">
        <button
          type="button"
          className="tree-group-header"
          aria-expanded={partsOpen === "open"}
          onClick={() => setPartsOpen(partsOpen === "open" ? "closed" : "open")}
        >
          <span className="chevron" aria-hidden="true">
            {partsOpen === "open" ? "▾" : "▸"}
          </span>
          Parts ({parts.length})
        </button>
        {partsOpen === "open" && parts.length > 0 && (
          <ul className="tree-children">
            {parts.map((part, index) => (
              <li key={part}>
                <span className="tree-item static">
                  <Icon name="part" />
                  Part {index + 1}
                  {part !== "main" && <small>{part}</small>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}

function App() {
  const [features] = useState(initialFeatures);
  const [mesh, setMesh] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [selectedFeature, setSelectedFeature] = useState(null);
  const [picked, setPicked] = useState([]);
  const [measurement, setMeasurement] = useState(null);
  const [measuring, setMeasuring] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [roundTrip, setRoundTrip] = useState(null);

  const viewport = useRef(null);

  const compile = useCallback(async () => {
    if (!features.length) {
      // An empty feature tree is an empty model; there is nothing to build.
      setMesh(null);
      setMetrics(null);
      return;
    }
    setBusy(true);
    setError("");
    const started = performance.now();
    try {
      const result = await readResult(await post("/api/compile", { features }));
      setMesh(result.mesh);
      setMetrics(result.metrics);
      setRoundTrip(performance.now() - started);
    } catch (compileError) {
      setError(compileError.message);
    } finally {
      setBusy(false);
    }
  }, [features]);

  const exportStep = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const response = await post("/api/export/step", { features });
      if (!response.ok) await readResult(response);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "model.step";
      link.click();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(exportError.message);
    } finally {
      setBusy(false);
    }
  }, [features]);

  useEffect(() => {
    compile();
  }, [compile]);

  // Exact measurements come from the CAD kernel. The worker caches the built
  // model, so this only costs the measurement itself.
  useEffect(() => {
    setMeasurement(null);
    if (!picked.length) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setMeasuring(true);
      try {
        const result = await readResult(
          await post(
            "/api/measure",
            { features, selection: picked.map(({ kind, id }) => ({ kind, id })) },
            controller.signal,
          ),
        );
        setMeasurement(result);
      } catch (measureError) {
        if (measureError.name !== "AbortError") setError(measureError.message);
      } finally {
        if (!controller.signal.aborted) setMeasuring(false);
      }
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [picked, features]);

  return (
    <main className="app">
      <header className="topbar">
        <span className="brand">
          <Icon name="brand" />
          Paralogic
        </span>
        <span className="doc-title">Untitled part</span>
        <span className="doc-context">Part studio</span>
      </header>
      <div className="toolbar" role="toolbar" aria-label="Part tools">
        <button
          type="button"
          className="tool"
          onClick={compile}
          disabled={busy || !features.length}
          title="Rebuild the model from the feature tree"
        >
          <Icon name="rebuild" />
          <span>{busy ? "Working…" : "Rebuild"}</span>
        </button>
        <span className="tool-separator" aria-hidden="true" />
        <button
          type="button"
          className="tool"
          onClick={exportStep}
          disabled={busy || !mesh}
          title="Download the model as a STEP file"
        >
          <Icon name="export" />
          <span>Export STEP</span>
        </button>
      </div>
      <section className="workspace">
        <aside className="panel">
          <FeatureTree
            features={features}
            parts={mesh ? metrics?.parts || [] : []}
            picked={picked}
            selectedFeature={selectedFeature}
            onSelectFeature={setSelectedFeature}
            viewport={viewport}
          />
        </aside>
        <Viewport mesh={mesh} measurement={measurement} onPick={setPicked} apiRef={viewport}>
          <MeasurePanel measurement={measurement} picked={picked} pending={measuring} />
          {error && (
            <div className="error-toast" role="alert">
              <pre>{error}</pre>
              <button type="button" aria-label="Dismiss error" onClick={() => setError("")}>
                ×
              </button>
            </div>
          )}
        </Viewport>
      </section>
      <footer className="status-bar">
        {metrics && mesh ? (
          <>
            <span>
              Rebuilt in {Math.round(metrics.build_ms + (metrics.mesh_ms || 0))} ms
              {metrics.cached_features
                ? ` (${metrics.cached_features}/${metrics.features} features reused)`
                : ""}
              {roundTrip !== null && ` · round trip ${Math.round(roundTrip)} ms`}
            </span>
            <span>
              {metrics.faces} faces · {metrics.edges} edges · volume {formatNumber(metrics.volume)}
            </span>
          </>
        ) : (
          <span>{busy ? "Building…" : features.length ? "No model" : "Empty model — no features yet"}</span>
        )}
        <span>{picked.length ? `${picked.length} selected` : ""}</span>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
