import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ThreeViewCube } from "@chronosai/three-view-cube";
import { FontLoader } from "three/examples/jsm/loaders/FontLoader.js";
import { TextGeometry } from "three/examples/jsm/geometries/TextGeometry.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import helvetikerFont from "three/examples/fonts/helvetiker_regular.typeface.json";
import "./styles.css";

const initialFeatures = [
  // The worker receives this feature list and turns it into the mesh shown below.
  {
    type: "box",
    id: "base",
    params: { length: 40, width: 30, height: 10 },
  },
  {
    type: "hole",
    id: "hole",
    params: { target: "base", location: [0, 0, 5], radius: 3 },
  },
];

function Viewport({ mesh, onSelect }) {
  // These refs point to objects that must survive React renders without causing
  // the Three.js scene to be rebuilt every time the UI changes.
  const mount = useRef(null);
  const meshObject = useRef(null);
  const viewActions = useRef({});
  const [viewMenuOpen, setViewMenuOpen] = useState(false);

  useEffect(() => {
    // The viewport owns the Three.js scene, camera, controls, and interaction
    // overlays. Everything is created together so cleanup is straightforward.
    // A Scene is the container for every 3D object, light, and helper.
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf2f2f2);
    // The camera describes what the user sees. Its aspect ratio is corrected
    // in resize() after the viewport has a real browser size.
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
    camera.position.set(80, 70, 80);
    camera.lookAt(0, 0, 0);
    // The renderer draws the scene into a canvas attached to the viewport div.
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    mount.current.appendChild(renderer.domElement);
    mount.current.__scene = scene;
    // Selection and hover graphics live in separate groups so they can be
    // cleared without changing the actual compiled model.
    const selection = new THREE.Group();
    selection.renderOrder = 10;
    scene.add(selection);
    const hoverSelection = new THREE.Group();
    hoverSelection.renderOrder = 11;
    scene.add(hoverSelection);

    // A hemisphere light gives the model soft light from above and a lighter
    // fill from below, which keeps the neutral CAD colors readable.
    scene.add(new THREE.HemisphereLight(0xffffff, 0xaaaaaa, 2));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.zoomToCursor = true;
    controls.enablePan = true;
    controls.screenSpacePanning = true;
    controls.panSpeed = 0.8;
    controls.rotateSpeed = 0.7;
    controls.zoomSpeed = 1.1;
    controls.minDistance = 5;
    controls.maxDistance = 2000;

    // Reference planes use real 3D text so labels rotate and can be occluded.
    const planeFont = new FontLoader().parse(helvetikerFont);
    const addPlaneLabel = (text, rotation) => {
      const label = new THREE.Mesh(
        new TextGeometry(text, {
          font: planeFont,
          size: 4,
          depth: 0.08,
          curveSegments: 4,
        }),
        new THREE.MeshBasicMaterial({
          color: 0x3f515d,
          side: THREE.DoubleSide,
          depthTest: true,
          depthWrite: false,
        }),
      );
      label.rotation.copy(rotation);
      const localPosition = new THREE.Vector3(-70, 68, 0.12).applyEuler(
        rotation,
      );
      label.position.copy(localPosition);
      label.renderOrder = 4;
      scene.add(label);
    };
    // Plane size is intentionally fixed at 150 units. The color argument is
    // kept in the helper API for readability when defining the three planes.
    const addReferencePlane = (rotation, color) => {
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(150, 150),
        new THREE.MeshBasicMaterial({
          color: 0xc7d8e2,
          transparent: true,
          opacity: 0.18,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      plane.rotation.copy(rotation);
      scene.add(plane);
    };
    const addReferencePlaneOutline = (rotation) => {
      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(150, 150)),
        new THREE.LineBasicMaterial({
          color: 0x7a8790,
          transparent: true,
          opacity: 0.82,
        }),
      );
      outline.rotation.copy(rotation);
      scene.add(outline);
    };
    addReferencePlane(new THREE.Euler(0, 0, 0), 0xd6d6d6);
    addReferencePlane(new THREE.Euler(Math.PI / 2, Math.PI, Math.PI), 0xd6d6d6);
    addReferencePlane(new THREE.Euler(0, Math.PI / 2, 0), 0xd6d6d6);
    addReferencePlaneOutline(new THREE.Euler(0, 0, 0));
    addReferencePlaneOutline(new THREE.Euler(Math.PI / 2, Math.PI, Math.PI));
    addReferencePlaneOutline(new THREE.Euler(0, Math.PI / 2, 0));
    addPlaneLabel("Front", new THREE.Euler(0, 0, 0));
    addPlaneLabel("Top", new THREE.Euler(Math.PI / 2, Math.PI, Math.PI));
    addPlaneLabel("Right", new THREE.Euler(0, Math.PI / 2, 0));
    // This package owns the cube geometry and its face/edge/corner hit testing.
    // We only connect it to our controls and place its DOM element in the corner.
    const viewCube = new ThreeViewCube(controls);
    viewCube.resolution = new THREE.Vector2(80, 80);
    viewCube.domElement.classList.add("view-cube");
    mount.current.appendChild(viewCube.domElement);

    // Camera moves are animated rather than jumping between orientations.
    let cameraAnimation = null;
    const animateCamera = (position, up) => {
      if (cameraAnimation) cancelAnimationFrame(cameraAnimation.frame);
      const startPosition = camera.position.clone();
      const startQuaternion = camera.quaternion.clone();
      const endCamera = camera.clone();
      endCamera.position.copy(position);
      endCamera.up.copy(up);
      endCamera.lookAt(controls.target);
      const endPosition = position.clone();
      const endQuaternion = endCamera.quaternion.clone();
      const startedAt = performance.now();
      controls.enabled = false;
      const step = (now) => {
        const progress = THREE.MathUtils.smoothstep(
          THREE.MathUtils.clamp((now - startedAt) / 320, 0, 1),
          0,
          1,
        );
        camera.position.lerpVectors(startPosition, endPosition, progress);
        camera.quaternion.copy(startQuaternion).slerp(endQuaternion, progress);
        viewCube.updateCamera();
        cameraAnimation = { frame: requestAnimationFrame(step) };
        if (progress >= 1) {
          cancelAnimationFrame(cameraAnimation.frame);
          cameraAnimation = null;
          camera.position.copy(endPosition);
          camera.quaternion.copy(endQuaternion);
          camera.up.copy(endCamera.up);
          viewCube.updateCamera();
          controls.enabled = true;
        }
      };
      cameraAnimation = { frame: requestAnimationFrame(step) };
    };

    const alignCamera = (normal) => {
      // Keep the current distance so changing to a standard view does not zoom
      // the model unexpectedly.
      const distance = camera.position.distanceTo(controls.target);
      const direction = normal.clone().normalize();
      const position = controls.target
        .clone()
        .add(direction.multiplyScalar(distance));
      const worldUp =
        Math.abs(direction.y) > 0.9
          ? new THREE.Vector3(0, 0, 1)
          : new THREE.Vector3(0, 1, 0);
      animateCamera(position, worldUp);
    };
    const rotateView = (angle) => {
      // Rolling changes camera.up around the viewing direction, not the target.
      const direction = camera.position
        .clone()
        .sub(controls.target)
        .normalize();
      const up = camera.up.clone().applyAxisAngle(direction, angle).normalize();
      animateCamera(camera.position.clone(), up);
    };
    const orbitView = (thetaDelta, phiDelta) => {
      // Spherical coordinates make the arrow buttons rotate around the model
      // without manually calculating Cartesian camera positions.
      const offset = camera.position.clone().sub(controls.target);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      spherical.theta += thetaDelta;
      spherical.phi = THREE.MathUtils.clamp(
        spherical.phi + phiDelta,
        0.08,
        Math.PI - 0.08,
      );
      const position = controls.target
        .clone()
        .add(new THREE.Vector3().setFromSpherical(spherical));
      const up =
        Math.abs(position.y - controls.target.y) / offset.length() > 0.9
          ? new THREE.Vector3(0, 0, position.y > controls.target.y ? -1 : 1)
          : new THREE.Vector3(0, 1, 0);
      animateCamera(position, up);
    };
    const setPreset = (preset) => {
      // Presets only choose a direction; animateCamera handles the transition.
      const distance = camera.position.distanceTo(controls.target);
      const directions = {
        isometric: new THREE.Vector3(1, 1, 1),
        dimetric: new THREE.Vector3(1, 1.35, 1),
        trimetric: new THREE.Vector3(1.2, 1, 0.8),
      };
      const direction = directions[preset];
      if (direction) {
        const position = controls.target
          .clone()
          .add(direction.normalize().multiplyScalar(distance));
        animateCamera(position, new THREE.Vector3(0, 1, 0));
      }
    };
    viewActions.current = {
      rotateLeft: () => rotateView(Math.PI / 12),
      rotateRight: () => rotateView(-Math.PI / 12),
      orbitLeft: () => orbitView(Math.PI / 8, 0),
      orbitRight: () => orbitView(-Math.PI / 8, 0),
      orbitUp: () => orbitView(0, -Math.PI / 12),
      orbitDown: () => orbitView(0, Math.PI / 12),
      setPreset,
    };
    const resize = () => {
      // The camera and renderer must use the same aspect ratio or the model
      // will appear stretched when the window or sidebar changes size.
      const { width, height } = mount.current.getBoundingClientRect();
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    const render = () => {
      // This is the animation loop. It redraws the main scene and synchronizes
      // the prebuilt view cube with the current camera orientation.
      const bounds = mount.current.getBoundingClientRect();
      renderer.render(scene, camera);
      const origin = new THREE.Vector3(0, 0, 0).project(camera);
      const originBounds = mount.current.getBoundingClientRect();
      const originMarker = mount.current.querySelector(".origin-marker");
      if (originMarker) {
        originMarker.style.left = `${(origin.x * 0.5 + 0.5) * originBounds.width}px`;
        originMarker.style.top = `${(-origin.y * 0.5 + 0.5) * originBounds.height}px`;
        originMarker.style.display =
          origin.z >= -1 && origin.z <= 1 ? "block" : "none";
      }
      viewCube.update(1 / 60);
      viewCube.render();
      requestAnimationFrame(render);
    };
    // Vertex markers are sprites so their diameter stays consistent on screen.
    const createVertexMarker = (
      position,
      outlineColor,
      fillColor,
      diameter,
    ) => {
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      const context = canvas.getContext("2d");
      const color = (value) => `#${value.toString(16).padStart(6, "0")}`;
      context.beginPath();
      context.arc(16, 16, 11, 0, Math.PI * 2);
      if (fillColor !== 0x000000) {
        context.fillStyle = color(fillColor);
        context.globalAlpha = 0.7;
        context.fill();
        context.globalAlpha = 1;
      }
      context.strokeStyle = color(outlineColor);
      context.lineWidth = 3;
      context.stroke();
      const marker = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: new THREE.CanvasTexture(canvas),
          transparent: true,
          depthTest: false,
        }),
      );
      marker.position.copy(position);
      marker.scale.setScalar(diameter);
      marker.renderOrder = 20;
      return marker;
    };
    const createThickLines = (geometry, color, width) => {
      // WebGL commonly ignores LineBasicMaterial.linewidth. LineSegments2 uses
      // a shader instead, so its width works consistently across browsers.
      const lineGeometry = new LineSegmentsGeometry();
      lineGeometry.setPositions(Array.from(geometry.attributes.position.array));
      const lineMaterial = new LineMaterial({
        color,
        linewidth: width,
        worldUnits: true,
        depthTest: false,
        transparent: true,
      });
      lineMaterial.resolution.set(1000, 1000);
      const lines = new LineSegments2(lineGeometry, lineMaterial);
      lines.computeLineDistances();
      lines.renderOrder = 20;
      return lines;
    };
    // Tessellated CAD surfaces need topology-aware grouping. Adjacent triangles
    // are merged only while their normals remain within the smooth-surface angle.
    const smoothFaceTriangles = (triangles, startIndex, crease = 0.995) => {
      const edgeTriangles = new Map();
      const pointKey = (point) =>
        [point.x, point.y, point.z].map((value) => value.toFixed(5)).join(":");
      triangles.forEach((triangle, triangleIndex) => {
        for (let edge = 0; edge < 3; edge += 1) {
          const start = pointKey(triangle.points[edge]);
          const end = pointKey(triangle.points[(edge + 1) % 3]);
          const key = start < end ? `${start}:${end}` : `${end}:${start}`;
          const adjacent = edgeTriangles.get(key) || [];
          adjacent.push(triangleIndex);
          edgeTriangles.set(key, adjacent);
        }
      });
      const connected = new Set([startIndex]);
      const queue = [startIndex];
      while (queue.length) {
        const triangleIndex = queue.shift();
        const triangle = triangles[triangleIndex];
        for (let edge = 0; edge < 3; edge += 1) {
          const start = pointKey(triangle.points[edge]);
          const end = pointKey(triangle.points[(edge + 1) % 3]);
          const key = start < end ? `${start}:${end}` : `${end}:${start}`;
          for (const adjacentIndex of edgeTriangles.get(key) || []) {
            if (
              !connected.has(adjacentIndex) &&
              triangle.normal.dot(triangles[adjacentIndex].normal) > crease
            ) {
              connected.add(adjacentIndex);
              queue.push(adjacentIndex);
            }
          }
        }
      }
      return connected;
    };
    // Rounded edges are chains of short tessellation edges. Straight edges
    // remain separate because their directions change at real corners.
    const edgeComponent = (edges, startEdge) => {
      const pointKey = (point) =>
        [point.x, point.y, point.z].map((value) => value.toFixed(5)).join(":");
      const direction = (edge) => edge.end.clone().sub(edge.start).normalize();
      const components = new Set([startEdge]);
      const queue = [startEdge];
      while (queue.length) {
        const edge = queue.shift();
        const endpoints = new Set([pointKey(edge.start), pointKey(edge.end)]);
        const edgeDirection = direction(edge);
        edges.forEach((candidate) => {
          const candidateDirection = direction(candidate);
          if (
            !components.has(candidate) &&
            (endpoints.has(pointKey(candidate.start)) ||
              endpoints.has(pointKey(candidate.end))) &&
            Math.abs(edgeDirection.dot(candidateDirection)) > 0.8
          ) {
            components.add(candidate);
            queue.push(candidate);
          }
        });
      }
      return [...components];
    };
    // A tessellation point is not necessarily a CAD vertex. Real vertices are
    // endpoints where multiple actual boundaries meet.
    const realVertices = (edges, pointKey) => {
      // Mesh vertices are often duplicated by tessellation. Counting boundary
      // connections prevents a point halfway around a cylinder becoming a
      // selectable CAD vertex.
      const degree = new Map();
      edges.forEach(({ start, end }) => {
        for (const point of [start, end]) {
          const key = pointKey(point);
          degree.set(key, (degree.get(key) || 0) + 1);
        }
      });
      return [...degree.entries()]
        .filter(([, count]) => count >= 3)
        .map(([key]) => {
          const edge = edges.find(
            ({ start, end }) =>
              pointKey(start) === key || pointKey(end) === key,
          );
          return pointKey(edge.start) === key ? edge.start : edge.end;
        });
    };
    // Straight edges also expose a midpoint vertex for CAD-style picking.
    const edgeMidpoints = (edges) => {
      // Midpoints are useful construction points on straight CAD edges, but
      // curved chains are deliberately excluded.
      const midpoints = [];
      const visited = new Set();
      edges.forEach((edge) => {
        if (visited.has(edge)) return;
        const component = edgeComponent(edges, edge);
        component.forEach((member) => visited.add(member));
        if (component.length === 1) {
          midpoints.push(
            component[0].start
              .clone()
              .add(component[0].end)
              .multiplyScalar(0.5),
          );
        }
      });
      return midpoints;
    };
    const removeSelectionKey = (key) => {
      [...selection.children]
        .filter((child) => child.userData.selectionKey === key)
        .forEach((child) => {
          selection.remove(child);
          child.geometry?.dispose();
          if (Array.isArray(child.material))
            child.material.forEach((material) => material.dispose());
          else child.material?.dispose();
        });
    };
    // Model clicks use the same topology rules as hover, and every click toggles
    // the hit item so users can build a multi-selection without modifier keys.
    const click = (event) => {
      if (!meshObject.current) return;
      if (!meshObject.current) return;
      const bounds = mount.current.getBoundingClientRect();
      const pointer = new THREE.Vector2(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      // Raycasting converts the 2D mouse position into a 3D hit on the model.
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(meshObject.current, false)[0];
      if (!hit || hit.faceIndex === undefined) return;
      const selectionStart = selection.children.length;
      selection.position.copy(meshObject.current.position);
      const geometry = meshObject.current.geometry;
      const index = geometry.index;
      const indices = index
        ? [
            index.getX(hit.faceIndex * 3),
            index.getX(hit.faceIndex * 3 + 1),
            index.getX(hit.faceIndex * 3 + 2),
          ]
        : [hit.faceIndex * 3, hit.faceIndex * 3 + 1, hit.faceIndex * 3 + 2];
      const positions = geometry.attributes.position;
      const localHit = meshObject.current.worldToLocal(hit.point.clone());
      const modelBounds = new THREE.Box3().setFromObject(meshObject.current);
      const threshold =
        modelBounds.getSize(new THREE.Vector3()).length() * 0.045;
      // The builder returns triangles. We rebuild lightweight adjacency data
      // here because the raw render mesh does not include CAD face identities.
      const triangleCount = index ? index.count / 3 : positions.count / 3;
      const triangles = [];
      const edgeMap = new Map();
      const pointKey = (point) =>
        [point.x, point.y, point.z].map((value) => value.toFixed(5)).join(":");
      for (let triangle = 0; triangle < triangleCount; triangle += 1) {
        const triangleIndices = index
          ? [
              index.getX(triangle * 3),
              index.getX(triangle * 3 + 1),
              index.getX(triangle * 3 + 2),
            ]
          : [triangle * 3, triangle * 3 + 1, triangle * 3 + 2];
        const trianglePoints = triangleIndices.map((value) =>
          new THREE.Vector3().fromBufferAttribute(positions, value),
        );
        const normal = new THREE.Triangle(...trianglePoints).getNormal(
          new THREE.Vector3(),
        );
        triangles.push({
          indices: triangleIndices,
          points: trianglePoints,
          normal,
        });
        for (let edge = 0; edge < 3; edge += 1) {
          const start = trianglePoints[edge];
          const end = trianglePoints[(edge + 1) % 3];
          const startKey = pointKey(start);
          const endKey = pointKey(end);
          const key =
            startKey < endKey
              ? `${startKey}:${endKey}`
              : `${endKey}:${startKey}`;
          const entry = edgeMap.get(key) || { start, end, normals: [] };
          entry.normals.push(normal);
          edgeMap.set(key, entry);
        }
      }
      const sharpEdges = [...edgeMap.values()].filter(
        ({ normals }) =>
          normals.length === 1 ||
          normals.some((normal, index) =>
            normals.slice(index + 1).some((other) => normal.dot(other) < 0.75),
          ),
      );
      const sharpVertices = [
        ...realVertices(sharpEdges, pointKey),
        ...edgeMidpoints(sharpEdges),
      ];
      const nearestVertex = sharpVertices.reduce(
        (best, value) => {
          const point = value;
          const distance = point.distanceTo(localHit);
          return distance < best.distance ? { distance, value, point } : best;
        },
        { distance: Infinity, value: 0, point: new THREE.Vector3() },
      );
      let kind = "face";
      if (nearestVertex.distance < threshold) {
        kind = "corner";
        const marker = createVertexMarker(
          nearestVertex.point,
          0xf28c28,
          0xffc078,
          threshold * 0.85,
        );
        selection.add(marker);
      } else {
        const nearestEdge = sharpEdges.reduce((best, edge) => {
          const start = edge.start;
          const end = edge.end;
          const segment = new THREE.Line3(start, end);
          const closest = segment.closestPointToPoint(
            localHit,
            true,
            new THREE.Vector3(),
          );
          const distance = closest.distanceTo(localHit);
          return !best || distance < best.distance
            ? { start, end, distance }
            : best;
        }, null);
        if (nearestEdge && nearestEdge.distance < threshold) {
          kind = "edge";
          const edgeGeometry = new THREE.BufferGeometry();
          const component = edgeComponent(sharpEdges, nearestEdge);
          edgeGeometry.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(
              component.flatMap(({ start, end }) => [
                start.x,
                start.y,
                start.z,
                end.x,
                end.y,
                end.z,
              ]),
              3,
            ),
          );
          selection.add(createThickLines(edgeGeometry, 0xf28c28, 0.32));
        } else {
          const hitNormal = triangles[hit.faceIndex].normal;
          const facePoints = [];
          const faceIndices = [];
          const faceTriangles = smoothFaceTriangles(triangles, hit.faceIndex);
          triangles.forEach((triangle, triangleIndex) => {
            if (faceTriangles.has(triangleIndex)) {
              const offset = facePoints.length;
              facePoints.push(...triangle.points);
              faceIndices.push(offset, offset + 1, offset + 2);
            }
          });
          const faceGeometry = new THREE.BufferGeometry().setFromPoints(
            facePoints,
          );
          faceGeometry.setIndex(faceIndices);
          faceGeometry.computeVertexNormals();
          selection.add(
            new THREE.Mesh(
              faceGeometry,
              new THREE.MeshBasicMaterial({
                color: 0xf28c28,
                transparent: true,
                opacity: 0.5,
                depthTest: false,
                side: THREE.DoubleSide,
              }),
            ),
          );
          selection.add(
            createThickLines(
              new THREE.EdgesGeometry(faceGeometry, 45),
              0xf28c28,
              0.32,
            ),
          );
        }
      }
      const selectionKey = `${kind}:${hit.faceIndex}`;
      selection.children.slice(selectionStart).forEach((child) => {
        child.userData.selectionKey = selectionKey;
      });
      const wasSelected = selection.children
        .slice(0, selectionStart)
        .some((child) => child.userData.selectionKey === selectionKey);
      if (wasSelected) {
        removeSelectionKey(selectionKey);
        onSelect(null);
        return;
      }
      onSelect(`${kind}:${hit.faceIndex}`);
    };
    // Hover overlays are deliberately outline-only for faces; fills are reserved
    // for selected faces so the underlying model remains easy to read.
    const hover = (event) => {
      if (!meshObject.current) return;
      while (hoverSelection.children.length) {
        const child = hoverSelection.children.pop();
        child.geometry?.dispose();
        child.material?.dispose();
      }
      const bounds = mount.current.getBoundingClientRect();
      const pointer = new THREE.Vector2(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(meshObject.current, false)[0];
      if (!hit || hit.faceIndex === undefined) return;
      const geometry = meshObject.current.geometry;
      const index = geometry.index;
      const positions = geometry.attributes.position;
      const localHit = meshObject.current.worldToLocal(hit.point.clone());
      const modelBounds = new THREE.Box3().setFromObject(meshObject.current);
      const threshold =
        modelBounds.getSize(new THREE.Vector3()).length() * 0.045;
      const triangleCount = index ? index.count / 3 : positions.count / 3;
      const edgeMap = new Map();
      const triangles = [];
      const pointKey = (point) =>
        [point.x, point.y, point.z].map((value) => value.toFixed(5)).join(":");
      const hitIndices = index
        ? [
            index.getX(hit.faceIndex * 3),
            index.getX(hit.faceIndex * 3 + 1),
            index.getX(hit.faceIndex * 3 + 2),
          ]
        : [hit.faceIndex * 3, hit.faceIndex * 3 + 1, hit.faceIndex * 3 + 2];
      const hitPoints = hitIndices.map((value) =>
        new THREE.Vector3().fromBufferAttribute(positions, value),
      );
      for (let triangle = 0; triangle < triangleCount; triangle += 1) {
        const triangleIndices = index
          ? [
              index.getX(triangle * 3),
              index.getX(triangle * 3 + 1),
              index.getX(triangle * 3 + 2),
            ]
          : [triangle * 3, triangle * 3 + 1, triangle * 3 + 2];
        const points = triangleIndices.map((value) =>
          new THREE.Vector3().fromBufferAttribute(positions, value),
        );
        const normal = new THREE.Triangle(...points).getNormal(
          new THREE.Vector3(),
        );
        triangles.push({ points, normal });
        for (let edge = 0; edge < 3; edge += 1) {
          const start = points[edge];
          const end = points[(edge + 1) % 3];
          const startKey = pointKey(start);
          const endKey = pointKey(end);
          const key =
            startKey < endKey
              ? `${startKey}:${endKey}`
              : `${endKey}:${startKey}`;
          const entry = edgeMap.get(key) || { start, end, normals: [] };
          entry.normals.push(normal);
          edgeMap.set(key, entry);
        }
      }
      const sharpEdges = [...edgeMap.values()].filter(
        ({ normals }) =>
          normals.length === 1 ||
          normals.some((normal, index) =>
            normals.slice(index + 1).some((other) => normal.dot(other) < 0.75),
          ),
      );
      const vertex = [
        ...realVertices(sharpEdges, pointKey),
        ...edgeMidpoints(sharpEdges),
      ].sort((a, b) => a.distanceTo(localHit) - b.distanceTo(localHit))[0];
      if (vertex && vertex.distanceTo(localHit) < threshold) {
        const marker = createVertexMarker(
          vertex,
          0xffc078,
          0x000000,
          threshold * 0.85,
        );
        hoverSelection.position.copy(meshObject.current.position);
        hoverSelection.add(marker);
        marker.renderOrder = 20;
        return;
      }
      const edge = sharpEdges
        .map(({ start, end }) => {
          const a = start;
          const b = end;
          const closest = new THREE.Line3(a, b).closestPointToPoint(
            localHit,
            true,
            new THREE.Vector3(),
          );
          return { a, b, distance: closest.distanceTo(localHit) };
        })
        .sort((a, b) => a.distance - b.distance)[0];
      if (edge && edge.distance < threshold) {
        const edgeGeometry = new THREE.BufferGeometry();
        const nearestSharpEdge = sharpEdges.find(
          ({ start, end }) =>
            (start === edge.a && end === edge.b) ||
            (start === edge.b && end === edge.a),
        );
        const component = edgeComponent(sharpEdges, nearestSharpEdge);
        edgeGeometry.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(
            component.flatMap(({ start, end }) => [
              start.x,
              start.y,
              start.z,
              end.x,
              end.y,
              end.z,
            ]),
            3,
          ),
        );
        hoverSelection.position.copy(meshObject.current.position);
        hoverSelection.add(createThickLines(edgeGeometry, 0xffc078, 0.28));
        return;
      }
      const facePoints = [];
      const faceIndices = [];
      const faceTriangles = smoothFaceTriangles(triangles, hit.faceIndex);
      triangles.forEach((triangle, triangleIndex) => {
        if (faceTriangles.has(triangleIndex)) {
          const offset = facePoints.length;
          facePoints.push(...triangle.points);
          faceIndices.push(offset, offset + 1, offset + 2);
        }
      });
      const faceGeometry = new THREE.BufferGeometry().setFromPoints(facePoints);
      faceGeometry.setIndex(faceIndices);
      faceGeometry.computeVertexNormals();
      hoverSelection.position.copy(meshObject.current.position);
      hoverSelection.add(
        createThickLines(
          new THREE.EdgesGeometry(faceGeometry, 45),
          0xffc078,
          0.28,
        ),
      );
    };
    const clearSelection = () => {
      // Spacebar uses the same cleanup path as any future deselect action.
      while (selection.children.length) {
        const child = selection.children.pop();
        child.geometry?.dispose();
        if (Array.isArray(child.material))
          child.material.forEach((material) => material.dispose());
        else child.material?.dispose();
      }
      onSelect(null);
    };
    const keyDown = (event) => {
      if (event.code === "Space") {
        event.preventDefault();
        clearSelection();
      }
    };
    const element = renderer.domElement;
    element.addEventListener("click", click);
    element.addEventListener("pointermove", hover, true);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("resize", resize);
    resize();
    render();

    return () => {
      window.removeEventListener("resize", resize);
      element.removeEventListener("click", click);
      element.removeEventListener("pointermove", hover, true);
      controls.dispose();
      mount.current?.removeChild(renderer.domElement);
      mount.current?.removeChild(viewCube.domElement);
      window.removeEventListener("keydown", keyDown);
      scene.remove(selection);
      scene.remove(hoverSelection);
      mount.current.__scene = null;
      viewActions.current = {};
      if (cameraAnimation) cancelAnimationFrame(cameraAnimation.frame);
      meshObject.current = null;
      renderer.dispose();
    };
  }, [onSelect]);

  useEffect(() => {
    const element = mount.current;
    if (!element || !mesh) return;
    const scene = element.__scene;
    // Convert the worker's flat vertex/index arrays into a Three.js geometry.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(mesh.vertices, 3),
    );
    geometry.setIndex(mesh.indices);
    geometry.computeVertexNormals();
    const object = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: 0xc7d8e2, roughness: 0.65 }),
    );
    // Center the compiled model at the origin so camera presets and planes
    // remain useful regardless of the source feature coordinates.
    const box = new THREE.Box3().setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    object.position.sub(center);
    const edgeLines = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry, 45),
      new THREE.LineBasicMaterial({
        color: 0x526b78,
        transparent: true,
        opacity: 0.9,
        linewidth: 3,
      }),
    );
    edgeLines.renderOrder = 2;
    object.add(edgeLines);
    object.name = "compiled-model";
    if (scene) {
      scene.add(object);
      meshObject.current = object;
    }
    return () => {
      geometry.dispose();
      object.material.dispose();
      edgeLines.geometry.dispose();
      edgeLines.material.dispose();
      scene?.remove(object);
      if (meshObject.current === object) meshObject.current = null;
    };
  }, [mesh]);

  return (
    <div className="viewport" ref={mount}>
      <div className="origin-marker" aria-hidden="true" />
      <div
        className="orientation-widget"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          className="orientation-menu-button"
          type="button"
          onClick={() => setViewMenuOpen((open) => !open)}
          aria-label="View presets"
        >
          ◈ <span>▾</span>
        </button>
        {viewMenuOpen && (
          <div className="view-menu">
            {["isometric", "dimetric", "trimetric"].map((preset) => (
              <button
                type="button"
                key={preset}
                onClick={() => {
                  viewActions.current.setPreset?.(preset);
                  setViewMenuOpen(false);
                }}
              >
                {preset[0].toUpperCase() + preset.slice(1)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function App() {
  const [features, setFeatures] = useState(initialFeatures);
  const [mesh, setMesh] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const compile = useCallback(async () => {
    // Compilation is deliberately kept in the React layer: the server returns
    // either a mesh payload or a clear error for the feature tree.
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ features }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error);
      setMesh(result.mesh);
    } catch (compileError) {
      setError(compileError.message);
    } finally {
      setBusy(false);
    }
  }, [features]);

  useEffect(() => {
    compile();
  }, [compile]);

  return (
    <main className="app">
      <header>
        <strong>Paralogic</strong>
        <button onClick={compile} disabled={busy}>
          {busy ? "Building..." : "Build model"}
        </button>
      </header>
      <section className="workspace">
        <aside className="tree">
          <h2>Feature tree</h2>
          {features.map((feature, index) => (
            <button
              className={selected === (feature.id || index) ? "selected" : ""}
              key={feature.id || index}
              onClick={() => setSelected(feature.id || index)}
            >
              {feature.id || `Feature ${index + 1}`}{" "}
              <small>{feature.type}</small>
            </button>
          ))}
          <p className="hint">
            Select a feature or click the model to inspect it.
            <br />
            Left drag: orbit · middle drag: pan · wheel: zoom
          </p>
          {error && <pre className="error">{error}</pre>}
        </aside>
        <Viewport mesh={mesh} onSelect={setSelected} />
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
