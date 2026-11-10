import * as THREE from "three";

// Mouse button numbers as reported by PointerEvent.button.
const MIDDLE = 1;

// The mouse layout follows Fusion: middle drag pans, Shift + middle drag
// orbits, and the wheel zooms. The left button is left free for selection,
// including box selection.
const BINDINGS = [
  { button: MIDDLE, modifier: "none", action: "pan" },
  { button: MIDDLE, modifier: "shift", action: "rotate" },
];

const ROTATE_SPEED = 0.008; // radians per pixel
const ZOOM_SPEED = 0.0015; // per wheel delta pixel
const ANIMATION_MS = 320;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

function modifierOf(event) {
  if (event.ctrlKey || event.metaKey) return "ctrl";
  if (event.shiftKey) return "shift";
  if (event.altKey) return "alt";
  return "none";
}

// Camera controls for CAD work. Both cameras share one pose: the active one is
// manipulated, and sync() copies it to the other and sizes the orthographic
// frustum from the distance to the target so switching projection keeps the
// framing. The view cube library only needs `object`, `target` and the
// "change" event, which this class provides.
export class CadControls extends THREE.EventDispatcher {
  constructor(perspective, orthographic, domElement, { pickPoint }) {
    super();
    this.perspective = perspective;
    this.orthographic = orthographic;
    this.domElement = domElement;
    this.pickPoint = pickPoint;
    this.target = new THREE.Vector3();
    this.projection = "perspective";
    this.rotationMode = "turntable";
    this.bindings = BINDINGS;
    this.enabled = true;
    this.minDistance = 0.5;
    this.maxDistance = 20000;
    this.pivot = null;
    this.drag = null;
    this.animation = null;

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onContextMenu = (event) => event.preventDefault();
    domElement.addEventListener("pointerdown", this._onPointerDown);
    domElement.addEventListener("pointermove", this._onPointerMove);
    domElement.addEventListener("pointerup", this._onPointerUp);
    domElement.addEventListener("pointercancel", this._onPointerUp);
    domElement.addEventListener("wheel", this._onWheel, { passive: false });
    domElement.addEventListener("contextmenu", this._onContextMenu);
  }

  get object() {
    return this.projection === "orthographic" ? this.orthographic : this.perspective;
  }

  get dragging() {
    return Boolean(this.drag?.moved);
  }

  dispose() {
    const element = this.domElement;
    element.removeEventListener("pointerdown", this._onPointerDown);
    element.removeEventListener("pointermove", this._onPointerMove);
    element.removeEventListener("pointerup", this._onPointerUp);
    element.removeEventListener("pointercancel", this._onPointerUp);
    element.removeEventListener("wheel", this._onWheel);
    element.removeEventListener("contextmenu", this._onContextMenu);
    if (this.animation) cancelAnimationFrame(this.animation);
  }

  setProjection(projection) {
    const source = this.object;
    this.projection = projection;
    this.object.position.copy(source.position);
    this.object.quaternion.copy(source.quaternion);
    this.object.up.copy(source.up);
    this.sync();
  }

  distance() {
    return this.object.position.distanceTo(this.target);
  }

  // Copies the active camera's pose to the other camera and updates the
  // orthographic frustum. Called every frame because the view cube moves the
  // active camera directly while it animates.
  sync() {
    const active = this.object;
    const other = active === this.perspective ? this.orthographic : this.perspective;
    other.position.copy(active.position);
    other.quaternion.copy(active.quaternion);
    other.up.copy(active.up);
    const halfHeight =
      this.distance() * Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2));
    const ortho = this.orthographic;
    const aspect = this.perspective.aspect;
    if (
      Math.abs(ortho.top - halfHeight) > 1e-9 ||
      Math.abs(ortho.right - halfHeight * aspect) > 1e-9
    ) {
      ortho.top = halfHeight;
      ortho.bottom = -halfHeight;
      ortho.right = halfHeight * aspect;
      ortho.left = -halfHeight * aspect;
      ortho.updateProjectionMatrix();
    }
    this.perspective.updateMatrixWorld();
    this.orthographic.updateMatrixWorld();
  }

  changed() {
    this.sync();
    this.dispatchEvent({ type: "change" });
  }

  _bindingFor(event) {
    const modifier = modifierOf(event);
    return this.bindings.find(
      (binding) => binding.button === event.button && binding.modifier === modifier,
    );
  }

  _onPointerDown(event) {
    if (!this.enabled) return;
    const binding = this._bindingFor(event);
    if (!binding) return;
    if (this.animation) {
      cancelAnimationFrame(this.animation);
      this.animation = null;
    }
    event.preventDefault();
    this.domElement.setPointerCapture(event.pointerId);
    const anchor = this.pickPoint(event.clientX, event.clientY) || this._targetPlanePoint(event);
    this.drag = {
      action: binding.action,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      anchor,
      moved: false,
    };
  }

  _onPointerMove(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.moved) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 3) return;
      drag.moved = true;
      if (drag.action === "rotate") this.pivot = drag.anchor.clone();
      this.dispatchEvent({ type: "start", action: drag.action });
    }
    if (drag.action === "rotate") this._rotate(dx, dy, drag.anchor);
    else if (drag.action === "pan") this._pan(dx, dy, drag.anchor);
    this.changed();
  }

  _onPointerUp(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.drag = null;
    this.pivot = null;
    if (this.domElement.hasPointerCapture(event.pointerId)) {
      this.domElement.releasePointerCapture(event.pointerId);
    }
    if (drag.moved) {
      // Swallow the click that ends a drag so it does not change the selection.
      const swallow = (click) => click.stopImmediatePropagation();
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      this.dispatchEvent({ type: "end" });
    }
    this.changed();
  }

  _onWheel(event) {
    if (!this.enabled) return;
    event.preventDefault();
    if (this.animation) {
      cancelAnimationFrame(this.animation);
      this.animation = null;
    }
    const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
    const anchor =
      this.pickPoint(event.clientX, event.clientY) || this._targetPlanePoint(event);
    this._zoomAbout(anchor, Math.exp(pixels * ZOOM_SPEED));
    this.changed();
  }

  // The point under the cursor on the plane through the target that faces the
  // camera, used when the cursor is not over the model.
  _targetPlanePoint(event) {
    const bounds = this.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    this.sync();
    raycaster.setFromCamera(pointer, this.object);
    const normal = this.object.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, this.target);
    return raycaster.ray.intersectPlane(plane, new THREE.Vector3()) || this.target.clone();
  }

  _rotateAround(pivot, rotation) {
    const camera = this.object;
    camera.position.sub(pivot).applyQuaternion(rotation).add(pivot);
    camera.quaternion.premultiply(rotation);
    camera.up.applyQuaternion(rotation);
    this.target.sub(pivot).applyQuaternion(rotation).add(pivot);
  }

  // Rotation is about the pivot under the cursor. Turntable keeps the CAD Z
  // axis vertical on screen; trackball rotates freely about the screen axes.
  // Neither stops at the poles.
  _rotate(dx, dy, pivot) {
    const camera = this.object;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const vertical =
      this.rotationMode === "turntable"
        ? WORLD_UP
        : new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const rotation = new THREE.Quaternion()
      .setFromAxisAngle(vertical, -dx * ROTATE_SPEED)
      .multiply(new THREE.Quaternion().setFromAxisAngle(right, -dy * ROTATE_SPEED));
    this._rotateAround(pivot, rotation);
  }

  // Pans so the grabbed point stays under the cursor.
  _pan(dx, dy, anchor) {
    const camera = this.object;
    const height = this.domElement.clientHeight || 1;
    let worldPerPixel;
    if (this.projection === "orthographic") {
      worldPerPixel = (this.orthographic.top - this.orthographic.bottom) / height;
    } else {
      const forward = camera.getWorldDirection(new THREE.Vector3());
      const depth = Math.max(anchor.clone().sub(camera.position).dot(forward), 1e-3);
      worldPerPixel =
        (2 * depth * Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2))) / height;
    }
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const offset = right
      .multiplyScalar(-dx * worldPerPixel)
      .add(up.multiplyScalar(dy * worldPerPixel));
    camera.position.add(offset);
    this.target.add(offset);
  }

  // Scales the camera and target about the anchor, which keeps the anchor at
  // the same screen position in both projections (the orthographic frustum is
  // derived from the camera-target distance).
  _zoomAbout(anchor, factor) {
    const distance = this.distance();
    const clamped =
      THREE.MathUtils.clamp(distance * factor, this.minDistance, this.maxDistance) / distance;
    if (Math.abs(clamped - 1) < 1e-9) return;
    const camera = this.object;
    camera.position.sub(anchor).multiplyScalar(clamped).add(anchor);
    this.target.sub(anchor).multiplyScalar(clamped).add(anchor);
  }

  // Orbits about the target, as when dragging the view cube.
  orbit(dx, dy) {
    if (this.animation) {
      cancelAnimationFrame(this.animation);
      this.animation = null;
    }
    this._rotate(dx, dy, this.target.clone());
    this.changed();
  }

  // One step of the view cube's arrows: "yaw" turns about the screen's
  // vertical axis, "pitch" about its horizontal axis and "roll" about the
  // view direction. A positive yaw brings the right side into view and a
  // positive pitch the top. From a standard view (looking along an axis) a
  // step is 90°, so it lands on the next standard view; otherwise it is 15°.
  stepRotate(kind, sign) {
    const camera = this.object;
    const direction = camera.position.clone().sub(this.target).normalize();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const aligned =
      Math.max(Math.abs(direction.x), Math.abs(direction.y), Math.abs(direction.z)) >
      Math.cos(THREE.MathUtils.degToRad(1));
    const angle = (aligned ? Math.PI / 2 : Math.PI / 12) * sign;
    const rotation = new THREE.Quaternion();
    if (kind === "yaw") rotation.setFromAxisAngle(up, angle);
    else if (kind === "pitch") rotation.setFromAxisAngle(right, -angle);
    else rotation.setFromAxisAngle(direction, angle);
    this.animateTo({
      direction: direction.applyQuaternion(rotation),
      up: up.applyQuaternion(rotation),
    });
  }

  // Animates to a camera pose. `direction` points from the target to the
  // camera; `up` is the screen-up direction.
  animateTo({ target = this.target, direction, up, distance = this.distance() }) {
    if (this.animation) cancelAnimationFrame(this.animation);
    const camera = this.object;
    const endTarget = target.clone();
    const endPosition = endTarget.clone().add(direction.clone().normalize().multiplyScalar(distance));
    const endQuaternion = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(endPosition, endTarget, up),
    );
    const start = {
      target: this.target.clone(),
      distance: this.distance(),
      quaternion: camera.quaternion.clone(),
    };
    const startedAt = performance.now();
    const forward = new THREE.Vector3();
    const step = (now) => {
      const t = THREE.MathUtils.smoothstep(Math.min((now - startedAt) / ANIMATION_MS, 1), 0, 1);
      camera.quaternion.slerpQuaternions(start.quaternion, endQuaternion, t);
      this.target.lerpVectors(start.target, endTarget, t);
      const currentDistance = THREE.MathUtils.lerp(start.distance, distance, t);
      // Orbit the target rather than cutting through the model.
      forward.set(0, 0, 1).applyQuaternion(camera.quaternion);
      camera.position.copy(this.target).addScaledVector(forward, currentDistance);
      camera.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
      this.changed();
      this.animation = t < 1 ? requestAnimationFrame(step) : null;
    };
    this.animation = requestAnimationFrame(step);
  }
}
