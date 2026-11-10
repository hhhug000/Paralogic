from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import sys
import time
from array import array
from collections import OrderedDict
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from build123d import (
    Axis,
    Box,
    BuildLine,
    BuildPart,
    BuildSketch,
    Circle,
    Compound,
    CounterBoreHole,
    Cylinder,
    Face,
    Hole,
    Line,
    Location,
    Locations,
    Mode,
    Plane,
    PolarLocations,
    RadiusArc,
    Rectangle,
    Sphere,
    Spline,
    Vector,
    Vertex,
    export_step,
    extrude,
    insert,
    loft,
    make_face,
    mirror,
    revolve,
    sweep,
)
from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.GCPnts import GCPnts_TangentialDeflection
from OCP.GeomAbs import GeomAbs_SurfaceType
from OCP.TopAbs import TopAbs_Orientation
from OCP.TopLoc import TopLoc_Location

FeatureHandler = Callable[["ModelBuilder", Mapping[str, Any]], Any]

# Hard limits that keep a single request from monopolising the worker.
MAX_FEATURES = 500
MAX_PATTERN_INSTANCES = 1000
MIN_VOLUME = 1e-9
GEOMETRY_TOLERANCE = 1e-6
# Tessellation: the linear deflection scales with the model (a fraction of its
# bounding-box diagonal, within limits) and the angular deflection is fixed.
MESH_RELATIVE_TOLERANCE = 0.001
MESH_MIN_TOLERANCE = 0.005
MESH_MAX_TOLERANCE = 1.0
MESH_ANGULAR_TOLERANCE = 0.25

EDGE_CURVE = 0
EDGE_LINE = 1
EDGE_SEAM = 2


class FeatureRegistry:
    def __init__(self) -> None:
        self._registry: dict[str, FeatureHandler] = {}

    def register(self, feature_type: str) -> Callable[[FeatureHandler], FeatureHandler]:
        if not feature_type:
            raise ValueError("Feature type cannot be empty.")

        def decorator(handler: FeatureHandler) -> FeatureHandler:
            if feature_type in self._registry:
                raise ValueError(f"Feature type is already registered: '{feature_type}'")
            self._registry[feature_type] = handler
            return handler

        return decorator

    def get(self, feature_type: str) -> FeatureHandler:
        try:
            return self._registry[feature_type]
        except KeyError as error:
            supported = ", ".join(sorted(self._registry))
            raise ValueError(
                f"Unknown feature type: '{feature_type}'. Supported types: {supported}"
            ) from error


registry = FeatureRegistry()


def _is_number(value: Any) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float))


def _number(params: Mapping[str, Any], name: str, default: float) -> float:
    value = params.get(name, default)
    if not _is_number(value):
        raise ValueError(f"'{name}' must be a number.")
    if not math.isfinite(value):
        raise ValueError(f"'{name}' must be finite.")
    return float(value)


def _positive_number(params: Mapping[str, Any], name: str, default: float) -> float:
    value = _number(params, name, default)
    if value <= 0:
        raise ValueError(f"'{name}' must be greater than zero.")
    return value


def _count(params: Mapping[str, Any], name: str, default: int) -> int:
    value = params.get(name, default)
    if not _is_number(value) or not float(value).is_integer():
        raise ValueError(f"'{name}' must be a whole number.")
    if value < 1:
        raise ValueError(f"'{name}' must be at least 1.")
    return int(value)


def _boolean(params: Mapping[str, Any], name: str, default: bool) -> bool:
    value = params.get(name, default)
    if not isinstance(value, bool):
        raise ValueError(f"'{name}' must be true or false.")
    return value


def _numbers(value: Any, name: str, length: int) -> tuple[float, ...]:
    if (
        not isinstance(value, Sequence)
        or isinstance(value, (str, bytes))
        or len(value) != length
        or not all(_is_number(item) and math.isfinite(item) for item in value)
    ):
        word = {2: "two", 3: "three"}[length]
        raise ValueError(f"'{name}' must contain exactly {word} finite numbers.")
    return tuple(float(item) for item in value)


def _point(value: Any, name: str) -> tuple[float, float]:
    return _numbers(value, name, 2)  # type: ignore[return-value]


def _vector(value: Any, name: str) -> tuple[float, float, float]:
    return _numbers(value, name, 3)  # type: ignore[return-value]


def _point_list(value: Any, name: str) -> list[Vector]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)) or len(value) < 2:
        raise ValueError(f"'{name}' requires at least two points.")
    return [Vector(*_point(point, name)) for point in value]


def _axis(value: Any) -> Axis:
    if not isinstance(value, str):
        raise ValueError("'axis' must be one of X, Y, or Z.")
    axes = {"X": Axis.X, "Y": Axis.Y, "Z": Axis.Z}
    try:
        return axes[value.upper()]
    except KeyError as error:
        raise ValueError("'axis' must be one of X, Y, or Z.") from error


def _plane(value: Any) -> Plane:
    if not isinstance(value, str):
        raise ValueError("'plane' must be one of XY, XZ, or YZ.")
    planes = {"XY": Plane.XY, "XZ": Plane.XZ, "YZ": Plane.YZ}
    try:
        return planes[value.upper()]
    except KeyError as error:
        raise ValueError("'plane' must be one of XY, XZ, or YZ.") from error


def _volume(shape: Any) -> float:
    try:
        return float(getattr(shape, "volume", 0.0) or 0.0)
    except Exception:
        return 0.0


def _is_solid(shape: Any) -> bool:
    return shape is not None and _volume(shape) > MIN_VOLUME


def _require_solid(shape: Any, name: str) -> Any:
    if not _is_solid(shape):
        raise ValueError(f"'{name}' must refer to a 3D solid.")
    return shape


def _shape_reference(builder: ModelBuilder, reference: Any, name: str) -> Any:
    if reference is None:
        if builder.context is None:
            raise ValueError(f"'{name}' was omitted and there is no previous feature.")
        shape = builder.context
    else:
        if not isinstance(reference, str) or not reference:
            raise ValueError(f"'{name}' must be a non-empty feature id.")
        if reference not in builder.results:
            raise ValueError(f"Feature '{reference}' was not found.")
        shape = builder.results[reference]
    builder.consumed.append(shape)
    return shape


def _edge_sort_key(edge: Any) -> tuple[float, ...]:
    center = edge.center()
    return (
        round(float(center.X), 6),
        round(float(center.Y), 6),
        round(float(center.Z), 6),
        round(float(edge.length), 6),
    )


def _sorted_edges(shape: Any) -> list[Any]:
    # The kernel's native edge order can change between builds, so edge indexes
    # are defined against a geometric ordering instead (by center X, Y, Z).
    return sorted(shape.edges(), key=_edge_sort_key)


def _sorted_faces(shape: Any) -> list[Any]:
    def key(face: Any) -> tuple[float, ...]:
        center = face.center()
        return (
            round(float(center.X), 6),
            round(float(center.Y), 6),
            round(float(center.Z), 6),
            round(float(face.area), 6),
        )

    return sorted(shape.faces(), key=key)


def _round(value: float) -> float:
    return round(float(value), 6)


def _sorted_vertices(shape: Any) -> list[Any]:
    return sorted(
        shape.vertices(), key=lambda vertex: (_round(vertex.X), _round(vertex.Y), _round(vertex.Z))
    )


def _encode(values: Any, typecode: str) -> str:
    """Packs numbers as little-endian binary in base64, which the viewer turns
    straight into a typed array instead of parsing decimal text."""
    packed = values if isinstance(values, array) else array(typecode, values)
    if sys.byteorder == "big":
        packed = array(typecode, packed)
        packed.byteswap()
    return base64.b64encode(packed.tobytes()).decode("ascii")


def _surface_radius(face: Any) -> float:
    surface = BRepAdaptor_Surface(face.wrapped)
    kind = surface.GetType()
    if kind == GeomAbs_SurfaceType.GeomAbs_Cylinder:
        return surface.Cylinder().Radius()
    if kind == GeomAbs_SurfaceType.GeomAbs_Sphere:
        return surface.Sphere().Radius()
    return 0.0


def _edge_radius(edge: Any) -> float:
    if edge.geom_type.name != "CIRCLE":
        return 0.0
    return float(edge.radius)


def _mesh_with_topology(shape: Any) -> dict[str, Any]:
    """Tessellates the shape face by face and describes its B-rep topology.

    Triangles and their vertices are emitted contiguously per face, so the
    viewer can map a picked triangle to its CAD face and highlight a face by
    vertex range. Face and edge numbering matches the builder's own ordering,
    so a selected edge's index can be used directly in 'edge_indices'.
    Numeric arrays are base64-encoded little-endian binary (see _encode).
    """
    diagonal = shape.bounding_box().diagonal
    tolerance = min(max(diagonal * MESH_RELATIVE_TOLERANCE, MESH_MIN_TOLERANCE), MESH_MAX_TOLERANCE)
    shape.mesh(tolerance, MESH_ANGULAR_TOLERANCE)
    faces = _sorted_faces(shape)
    edges = _sorted_edges(shape)
    vertices = _sorted_vertices(shape)
    edge_index = {edge: index for index, edge in enumerate(edges)}
    vertex_index = {vertex: index for index, vertex in enumerate(vertices)}

    positions = array("f")
    indices = array("I")
    face_triangle_offsets = [0]
    face_vertex_offsets = [0]
    face_edges: list[int] = []
    face_edge_offsets = [0]
    edge_kinds = [EDGE_LINE if edge.geom_type.name == "LINE" else EDGE_CURVE for edge in edges]

    for face in faces:
        location = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation_s(face.wrapped, location)
        if triangulation is not None:
            transform = location.Transformation()
            offset = len(positions) // 3
            for node in range(1, triangulation.NbNodes() + 1):
                point = triangulation.Node(node).Transformed(transform)
                positions.extend((point.X(), point.Y(), point.Z()))
            reverse = face.wrapped.Orientation() == TopAbs_Orientation.TopAbs_REVERSED
            for triangle in triangulation.Triangles():
                a, b, c = triangle.Get()
                if reverse:
                    b, c = c, b
                indices.extend((a + offset - 1, b + offset - 1, c + offset - 1))
        face_triangle_offsets.append(len(indices) // 3)
        face_vertex_offsets.append(len(positions) // 3)

        boundary = []
        for edge in face.edges():
            index = edge_index[edge]
            if BRep_Tool.IsClosed_s(edge.wrapped, face.wrapped):
                # Seam edges only close a periodic surface; they are not real
                # boundaries and are neither drawn nor pickable.
                edge_kinds[index] = EDGE_SEAM
            elif index not in boundary:
                boundary.append(index)
        face_edges += boundary
        face_edge_offsets.append(len(face_edges))

    edge_points = array("f")
    edge_point_offsets = [0]
    edge_vertices: list[int] = []
    for edge in edges:
        if edge.geom_type.name == "LINE":
            for point in (edge.position_at(0), edge.position_at(1)):
                edge_points.extend((point.X, point.Y, point.Z))
        else:
            sampler = GCPnts_TangentialDeflection(
                BRepAdaptor_Curve(edge.wrapped), MESH_ANGULAR_TOLERANCE, tolerance
            )
            for i in range(1, sampler.NbPoints() + 1):
                point = sampler.Value(i)
                edge_points.extend((point.X(), point.Y(), point.Z()))
        edge_point_offsets.append(len(edge_points) // 3)
        ends = [vertex_index.get(vertex, -1) for vertex in edge.vertices()][:2]
        edge_vertices += ends + [-1] * (2 - len(ends))

    return {
        "encoding": "base64-le",
        "vertices": _encode(positions, "f"),
        "indices": _encode(indices, "I"),
        "topology": {
            "face_triangle_offsets": _encode(face_triangle_offsets, "I"),
            "face_vertex_offsets": _encode(face_vertex_offsets, "I"),
            "face_edges": _encode(face_edges, "I"),
            "face_edge_offsets": _encode(face_edge_offsets, "I"),
            "edge_points": _encode(edge_points, "f"),
            "edge_point_offsets": _encode(edge_point_offsets, "I"),
            "edge_kinds": _encode(edge_kinds, "B"),
            "edge_vertices": _encode(edge_vertices, "i"),
            "vertices": _encode(
                [coordinate for vertex in vertices for coordinate in (vertex.X, vertex.Y, vertex.Z)],
                "f",
            ),
            # Descriptive data for hover feedback in the viewer.
            "face_types": [face.geom_type.name.lower() for face in faces],
            "face_areas": _encode([face.area for face in faces], "f"),
            "face_radii": _encode([_surface_radius(face) for face in faces], "f"),
            "edge_types": [edge.geom_type.name.lower() for edge in edges],
            "edge_lengths": _encode([edge.length for edge in edges], "f"),
            "edge_radii": _encode([_edge_radius(edge) for edge in edges], "f"),
        },
    }


def _selected_edges(shape: Any, params: Mapping[str, Any]) -> list[Any]:
    edges = _sorted_edges(shape)
    indices = params.get("edge_indices")
    selector = params.get("edge_selector")
    if indices is not None and selector is not None:
        raise ValueError("Use either 'edge_indices' or 'edge_selector', not both.")
    if indices is not None:
        if (
            not isinstance(indices, Sequence)
            or isinstance(indices, (str, bytes))
            or any(isinstance(index, bool) or not isinstance(index, int) for index in indices)
        ):
            raise ValueError("'edge_indices' must be a list of integers.")
        if any(index < 0 or index >= len(edges) for index in indices):
            raise ValueError(f"Edge indexes must be between 0 and {len(edges) - 1}.")
        return [edges[index] for index in indices]
    if selector is None or selector == "all":
        return edges
    if selector not in {"X", "Y", "Z", "horizontal", "vertical"}:
        raise ValueError("'edge_selector' must be all, X, Y, Z, horizontal, or vertical.")
    selected = []
    for edge in edges:
        try:
            tangent = edge.tangent_at(0.5)
        except Exception:
            continue
        components = [abs(float(tangent.X)), abs(float(tangent.Y)), abs(float(tangent.Z))]
        dominant = "XYZ"[components.index(max(components))]
        if selector in {"X", "Y", "Z"} and dominant == selector:
            selected.append(edge)
        elif selector == "horizontal" and dominant in {"X", "Y"}:
            selected.append(edge)
        elif selector == "vertical" and dominant == "Z":
            selected.append(edge)
    return selected


def _fuse_all(shapes: list[Any]) -> Any:
    first, *rest = shapes
    return first.fuse(*rest) if rest else first


class BuildCache:
    """Remembers the state after every feature, keyed by a hash of the feature
    tree up to and including that feature. Editing a feature therefore only
    rebuilds that feature and the ones after it. Used by the long-running
    worker (serve mode); shapes are never mutated after they are produced, so
    snapshots can share them.
    """

    def __init__(self, size: int = 512, mesh_size: int = 8) -> None:
        self._states: OrderedDict[str, tuple[Any, dict[str, Any], dict[str, Any]]] = OrderedDict()
        self._meshes: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._valid: OrderedDict[str, bool] = OrderedDict()
        self._size = size
        self._mesh_size = mesh_size

    @staticmethod
    def _get(store: OrderedDict, key: str) -> Any:
        value = store.get(key)
        if value is not None:
            store.move_to_end(key)
        return value

    @staticmethod
    def _put(store: OrderedDict, key: str, value: Any, size: int) -> None:
        store[key] = value
        store.move_to_end(key)
        while len(store) > size:
            store.popitem(last=False)

    def state(self, key: str) -> Any:
        return self._get(self._states, key)

    def store_state(self, key: str, state: Any) -> None:
        self._put(self._states, key, state, self._size)

    def mesh(self, key: str) -> Any:
        return self._get(self._meshes, key)

    def store_mesh(self, key: str, mesh: dict[str, Any]) -> None:
        self._put(self._meshes, key, mesh, self._mesh_size)

    def validity(self, key: str) -> bool | None:
        return self._get(self._valid, key)

    def store_validity(self, key: str, valid: bool) -> None:
        self._put(self._valid, key, valid, self._size)


def _prefix_keys(feature_tree: Sequence[Any]) -> list[str]:
    keys = []
    digest = hashlib.sha256()
    for node in feature_tree:
        digest.update(json.dumps(node, sort_keys=True, separators=(",", ":")).encode())
        digest.update(b"\n")
        keys.append(digest.copy().hexdigest())
    return keys


def _milliseconds(start: float) -> float:
    return round((time.perf_counter() - start) * 1000, 1)


class ModelBuilder:
    def __init__(self, cache: BuildCache | None = None) -> None:
        self.context: Any = None
        self.results: dict[str, Any] = {}
        self.bodies: dict[str, Any] = {}
        self.consumed: list[Any] = []
        self.cache = cache
        self.cached_features = 0
        self.key: str | None = None

    def _update_bodies(self, body_id: str, result: Any) -> None:
        # Only solids become bodies; sketches and paths are construction input.
        if not _is_solid(result):
            return
        # A solid that is consumed by a feature in another body has been merged
        # into that body (for example by a union), so it must not be shown twice.
        for other_id, tip in list(self.bodies.items()):
            if other_id != body_id and any(tip is shape for shape in self.consumed):
                del self.bodies[other_id]
        self.bodies[body_id] = result

    def build(self, feature_tree: Any) -> Any:
        if not isinstance(feature_tree, Sequence) or isinstance(feature_tree, (str, bytes)):
            raise ValueError("Feature tree must be a list of feature objects.")
        if not feature_tree:
            raise ValueError("Feature tree is empty.")
        if len(feature_tree) > MAX_FEATURES:
            raise ValueError(f"Feature tree may contain at most {MAX_FEATURES} features.")

        self.context = None
        self.results = {}
        self.bodies = {}
        self.cached_features = 0
        keys = _prefix_keys(feature_tree) if self.cache else []
        self.key = keys[-1] if keys else None

        start = 0
        if self.cache:
            for index in range(len(keys) - 1, -1, -1):
                state = self.cache.state(keys[index])
                if state is not None:
                    context, results, bodies = state
                    self.context, self.results, self.bodies = context, dict(results), dict(bodies)
                    start = self.cached_features = index + 1
                    break

        for index in range(start, len(feature_tree)):
            node = feature_tree[index]
            if not isinstance(node, Mapping):
                raise ValueError(f"Feature {index} must be an object.")
            feature_type = node.get("type")
            if not isinstance(feature_type, str) or not feature_type:
                raise ValueError(f"Feature {index} is missing a valid 'type'.")
            params = node.get("params", {})
            if not isinstance(params, Mapping):
                raise ValueError(f"Feature {index} params must be an object.")
            feature_id = node.get("id")
            if feature_id is not None and (not isinstance(feature_id, str) or not feature_id):
                raise ValueError(f"Feature {index} has an invalid 'id'.")
            if feature_id in self.results:
                raise ValueError(f"Duplicate feature id: '{feature_id}'.")
            body_id = node.get("body", "main")
            if not isinstance(body_id, str) or not body_id:
                raise ValueError(f"Feature {index} has an invalid 'body'.")

            self.consumed = []
            try:
                result = registry.get(feature_type)(self, params)
                if result is None:
                    raise ValueError("Feature produced no result.")
            except Exception as error:
                raise ValueError(f"Feature {index} ('{feature_type}') failed: {error}") from error

            self.context = result
            if feature_id:
                self.results[feature_id] = result
            self._update_bodies(body_id, result)
            if self.cache:
                self.cache.store_state(
                    keys[index], (self.context, dict(self.results), dict(self.bodies))
                )

        if not self.bodies:
            raise ValueError("The feature tree must produce at least one 3D solid.")
        bodies = list(self.bodies.values())
        shape = bodies[0] if len(bodies) == 1 else Compound(bodies)
        # The validity check is expensive on large models, so it is cached too.
        valid = self.cache.validity(self.key) if self.cache and self.key else None
        if valid is None:
            valid = shape.is_valid
            if self.cache and self.key:
                self.cache.store_validity(self.key, valid)
        if not valid:
            raise ValueError("The resulting model is not a valid solid.")
        return shape

    def compile(
        self,
        feature_tree: Any,
        export_step_path: str | Path | None = None,
        include_mesh: bool = True,
    ) -> dict[str, Any]:
        try:
            started = time.perf_counter()
            shape = self.build(feature_tree)
            build_ms = _milliseconds(started)

            if export_step_path is not None:
                export_path = Path(export_step_path)
                export_path.parent.mkdir(parents=True, exist_ok=True)
                if not export_step(shape, str(export_path)):
                    raise ValueError("STEP export failed.")

            result: dict[str, Any] = {"success": True}
            if include_mesh:
                meshed = time.perf_counter()
                cached = self.cache.mesh(self.key) if self.cache and self.key else None
                if cached is None:
                    mesh = _mesh_with_topology(shape)
                    if not mesh["indices"]:
                        raise ValueError("Tessellation produced zero vertices or triangles.")
                    bbox = shape.bounding_box()
                    metrics = {
                        "parts": sorted(self.bodies),
                        "faces": len(shape.faces()),
                        "edges": len(shape.edges()),
                        "volume": _volume(shape),
                        "bounding_box": {
                            "min": [float(bbox.min.X), float(bbox.min.Y), float(bbox.min.Z)],
                            "max": [float(bbox.max.X), float(bbox.max.Y), float(bbox.max.Z)],
                        },
                    }
                    cached = {"mesh": mesh, "metrics": metrics}
                    if self.cache and self.key:
                        self.cache.store_mesh(self.key, cached)
                result["mesh"] = cached["mesh"]
                result["metrics"] = dict(cached["metrics"])
                result["metrics"]["mesh_ms"] = _milliseconds(meshed)
            else:
                result["metrics"] = {}
            result["metrics"].update(
                {
                    "build_ms": build_ms,
                    "features": len(feature_tree),
                    "cached_features": self.cached_features,
                }
            )
            return result
        except Exception as error:
            return {"success": False, "error": str(error) or type(error).__name__}

    def measure(self, feature_tree: Any, selection: Any) -> dict[str, Any]:
        """Describes selected faces, edges and vertices, and the distance and
        angle between two of them, using exact kernel geometry."""
        try:
            if (
                not isinstance(selection, Sequence)
                or isinstance(selection, (str, bytes))
                or not selection
            ):
                raise ValueError("'selection' must be a non-empty list.")
            # Datum planes and the origin exist without a model, so the feature
            # tree is only built when model geometry is selected.
            needs_model = any(
                not isinstance(entry, Mapping) or entry.get("kind") not in {"plane", "origin"}
                for entry in selection
            )
            catalogue: dict[str, list[Any]] = {}
            if needs_model:
                shape = self.build(feature_tree)
                catalogue = {
                    "face": _sorted_faces(shape),
                    "edge": _sorted_edges(shape),
                    "vertex": _sorted_vertices(shape),
                }
            items = []
            for entry in selection:
                if not isinstance(entry, Mapping):
                    raise ValueError("Selection entries must be objects.")
                kind, index = entry.get("kind"), entry.get("id")
                if kind == "plane":
                    if index not in REFERENCE_PLANES:
                        raise ValueError(f"Unknown reference plane: {index}.")
                    items.append((kind, index, _reference_plane_face(index)))
                    continue
                if kind == "origin":
                    items.append((kind, 0, Vertex(0, 0, 0)))
                    continue
                source = catalogue.get("edge" if kind == "midpoint" else kind)
                if source is None or not isinstance(index, int) or not 0 <= index < len(source):
                    raise ValueError(f"Unknown selection entry: {kind} {index}.")
                item = source[index]
                if kind == "midpoint":
                    point = item.position_at(0.5)
                    item = Vertex(point.X, point.Y, point.Z)
                items.append((kind, index, item))

            result: dict[str, Any] = {
                "success": True,
                "items": [_describe(kind, index, item) for kind, index, item in items],
            }
            if len(items) == 2:
                (_, _, first), (_, _, second) = items
                extrema = BRepExtrema_DistShapeShape(first.wrapped, second.wrapped)
                if extrema.IsDone() and extrema.NbSolution() > 0:
                    start, end = extrema.PointOnShape1(1), extrema.PointOnShape2(1)
                    result["distance"] = {
                        "value": extrema.Value(),
                        "from": [start.X(), start.Y(), start.Z()],
                        "to": [end.X(), end.Y(), end.Z()],
                        "delta": [end.X() - start.X(), end.Y() - start.Y(), end.Z() - start.Z()],
                    }
                angle = _angle_between(items[0], items[1])
                if angle is not None:
                    result["angle"] = angle
            return result
        except Exception as error:
            return {"success": False, "error": str(error) or type(error).__name__}


# The datum planes shown in the viewer; each normal matches the standard view
# that looks straight at it (Top, Front, Right).
REFERENCE_PLANES = {
    "XY": Plane.XY,
    "XZ": Plane.XZ,
    "YZ": Plane.YZ,
}
REFERENCE_PLANE_SIZE = 1e6


def _reference_plane_face(name: str) -> Any:
    # A very large face stands in for the infinite plane in distance queries.
    return Face.make_rect(REFERENCE_PLANE_SIZE, REFERENCE_PLANE_SIZE, REFERENCE_PLANES[name])


def _point_list3(point: Any) -> list[float]:
    return [float(point.X), float(point.Y), float(point.Z)]


def _describe(kind: str, index: int, item: Any) -> dict[str, Any]:
    description: dict[str, Any] = {"kind": kind, "id": index}
    if kind == "plane":
        description["type"] = "reference plane"
        description["normal"] = _point_list3(REFERENCE_PLANES[index].z_dir)
        return description
    if kind in {"vertex", "midpoint", "origin"}:
        description["position"] = _point_list3(item)
    elif kind == "edge":
        description["type"] = item.geom_type.name.lower()
        description["length"] = float(item.length)
        if item.geom_type.name == "CIRCLE":
            description["radius"] = float(item.radius)
            description["center"] = _point_list3(item.arc_center)
    else:
        description["type"] = item.geom_type.name.lower()
        description["area"] = float(item.area)
        if item.geom_type.name == "PLANE":
            description["normal"] = _point_list3(item.normal_at())
        radius = _surface_radius(item)
        if radius:
            description["radius"] = radius
    return description


def _direction(kind: str, item: Any) -> tuple[str, Vector] | None:
    if kind == "edge" and item.geom_type.name == "LINE":
        return "line", item.tangent_at(0).normalized()
    if kind in {"face", "plane"} and item.geom_type.name == "PLANE":
        return "plane", item.normal_at().normalized()
    return None


def _angle_between(first: tuple[str, int, Any], second: tuple[str, int, Any]) -> float | None:
    a = _direction(first[0], first[2])
    b = _direction(second[0], second[2])
    if a is None or b is None:
        return None
    cosine = min(1.0, abs(a[1].dot(b[1])))
    angle = math.degrees(math.acos(cosine))
    # Between a line and a plane the angle is measured to the plane itself.
    if a[0] != b[0]:
        angle = 90.0 - angle
    return round(angle, 9)


@registry.register("sketch")
def build_sketch(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    sketch_plane = _plane(params.get("plane", "XY"))
    entities = params.get("entities", [])
    if not isinstance(entities, Sequence) or isinstance(entities, (str, bytes)) or not entities:
        raise ValueError("'entities' must be a non-empty list.")

    regions: list[Mapping[str, Any]] = []
    curves: list[Mapping[str, Any]] = []
    for index, entity in enumerate(entities):
        if not isinstance(entity, Mapping):
            raise ValueError(f"Sketch entity {index} must be an object.")
        entity_type = entity.get("type")
        if entity_type in {"rectangle", "circle"}:
            regions.append(entity)
        elif entity_type in {"line", "arc", "spline"}:
            curves.append(entity)
        elif entity_type == "point":
            raise ValueError(
                "Point entities are construction geometry and cannot form a solid profile."
            )
        else:
            raise ValueError(f"Unsupported sketch entity: '{entity_type}'.")

    with BuildSketch(sketch_plane) as sketch_builder:
        for entity in regions:
            center = _point(entity.get("center", [0, 0]), "center")
            with Locations(center):
                if entity["type"] == "rectangle":
                    Rectangle(
                        _positive_number(entity, "width", 10),
                        _positive_number(entity, "height", 10),
                    )
                else:
                    Circle(_positive_number(entity, "radius", 5))
        if curves:
            # Lines, arcs and splines are 1D; they are drawn as one wire and the
            # closed loop they form becomes a face of the sketch.
            with BuildLine():
                for entity in curves:
                    if entity["type"] == "line":
                        Line(_point(entity.get("start"), "start"), _point(entity.get("end"), "end"))
                    elif entity["type"] == "arc":
                        RadiusArc(
                            _point(entity.get("start"), "start"),
                            _point(entity.get("end"), "end"),
                            _number(entity, "radius", 5),
                        )
                    else:
                        Spline(_point_list(entity.get("points"), "points"))
            try:
                make_face()
            except Exception as error:
                raise ValueError(
                    "Sketch lines, arcs and splines must form a single closed loop."
                ) from error
    sketch = sketch_builder.sketch
    if sketch is None or not sketch.faces():
        raise ValueError("Sketch produced no closed profile.")
    return sketch


@registry.register("path")
def build_path(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    entities = params.get("entities", [])
    if not isinstance(entities, Sequence) or isinstance(entities, (str, bytes)) or not entities:
        raise ValueError("'entities' must be a non-empty list.")

    def point(value: Any, name: str) -> tuple[float, ...]:
        # Paths are 3D; 2D points are accepted and placed at Z = 0.
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes)) and len(value) == 2:
            return (*_point(value, name), 0.0)
        return _vector(value, name)

    with BuildLine() as line_builder:
        for index, entity in enumerate(entities):
            if not isinstance(entity, Mapping):
                raise ValueError(f"Path entity {index} must be an object.")
            if entity.get("type") == "line":
                Line(point(entity.get("start"), "start"), point(entity.get("end"), "end"))
            elif entity.get("type") == "spline":
                raw_points = entity.get("points")
                if (
                    not isinstance(raw_points, Sequence)
                    or isinstance(raw_points, (str, bytes))
                    or len(raw_points) < 2
                ):
                    raise ValueError("Spline paths require at least two points.")
                Spline([Vector(*point(item, "points")) for item in raw_points])
            else:
                raise ValueError("Path entities currently support line and spline.")
    return line_builder.wire()


@registry.register("extrude")
def apply_extrude(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    profile = _shape_reference(builder, params.get("profile"), "profile")
    if not profile.faces() or _is_solid(profile):
        raise ValueError("'profile' must refer to a sketch.")
    distance = _number(params, "distance", 10)
    if distance == 0:
        raise ValueError("'distance' must not be zero.")
    symmetric = _boolean(params, "symmetric", False)
    with BuildPart() as part:
        extrude(profile, amount=distance, both=symmetric)
    return part.part


@registry.register("transform")
def apply_transform(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    shape = _shape_reference(builder, params.get("target"), "target")
    translation = _vector(params.get("translation", [0, 0, 0]), "translation")
    rotation = _vector(params.get("rotation", [0, 0, 0]), "rotation")
    return shape.moved(Location(translation, rotation))


def _check_revolve_profile(profile: Any, axis: Axis) -> None:
    direction = axis.direction
    for face in profile.faces():
        normal = face.normal_at()
        if abs(normal.dot(direction)) > GEOMETRY_TOLERANCE:
            raise ValueError(
                "The revolve axis must lie in the profile's plane "
                "(for example a sketch on XZ revolved about Z)."
            )
        # The profile must stay on one side of the axis, otherwise the revolved
        # solid would intersect itself.
        side = normal.cross(direction)
        offsets = [
            (edge.position_at(t) - axis.position).dot(side)
            for edge in face.edges()
            for t in (i / 16 for i in range(17))
        ]
        if min(offsets) < -GEOMETRY_TOLERANCE and max(offsets) > GEOMETRY_TOLERANCE:
            raise ValueError(
                "The profile crosses the revolve axis; move it to one side "
                "(sketch entities accept a 'center')."
            )


@registry.register("revolve")
def apply_revolve(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    profile = _shape_reference(builder, params.get("profile"), "profile")
    if not profile.faces() or _is_solid(profile):
        raise ValueError("'profile' must refer to a sketch.")
    angle = _number(params, "angle", 360)
    if angle == 0 or abs(angle) > 360:
        raise ValueError("'angle' must be non-zero and no greater than 360 degrees.")
    axis = _axis(params.get("axis", "Z"))
    _check_revolve_profile(profile, axis)
    with BuildPart() as part:
        revolve(profile, axis=axis, revolution_arc=angle)
    return part.part


@registry.register("sweep")
def apply_sweep(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    section = _shape_reference(builder, params.get("section"), "section")
    path = _shape_reference(builder, params.get("path"), "path")
    with BuildPart() as part:
        sweep(sections=section, path=path, is_frenet=_boolean(params, "frenet", False))
    return part.part


@registry.register("loft")
def apply_loft(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    profile_ids = params.get("profiles", [])
    if not isinstance(profile_ids, Sequence) or isinstance(profile_ids, (str, bytes)):
        raise ValueError("'profiles' must be a list of feature ids.")
    if len(profile_ids) < 2 or any(not isinstance(item, str) for item in profile_ids):
        raise ValueError("Loft requires at least two profile ids.")
    profiles = [_shape_reference(builder, profile_id, "profiles") for profile_id in profile_ids]
    with BuildPart() as part:
        loft(profiles)
    return part.part


@registry.register("box")
def build_box(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    return Box(
        _positive_number(params, "length", 10),
        _positive_number(params, "width", 10),
        _positive_number(params, "height", 10),
    )


@registry.register("cylinder")
def build_cylinder(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    return Cylinder(
        _positive_number(params, "radius", 5),
        _positive_number(params, "height", 10),
    )


@registry.register("sphere")
def build_sphere(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    return Sphere(_positive_number(params, "radius", 5))


def _boolean_operation(builder: ModelBuilder, params: Mapping[str, Any], operation: str) -> Any:
    target = _require_solid(_shape_reference(builder, params.get("target"), "target"), "target")
    tool = _require_solid(_shape_reference(builder, params.get("tool"), "tool"), "tool")
    return getattr(target, operation)(tool)


@registry.register("union")
def apply_union(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    return _boolean_operation(builder, params, "fuse")


@registry.register("cut")
def apply_cut(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    return _boolean_operation(builder, params, "cut")


@registry.register("intersect")
def apply_intersect(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    return _boolean_operation(builder, params, "intersect")


@registry.register("fillet")
def apply_fillet(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    shape = _require_solid(_shape_reference(builder, params.get("target"), "target"), "target")
    radius = _positive_number(params, "radius", 1)
    edges = _selected_edges(shape, params)
    if not edges:
        raise ValueError("No edges matched the selection.")
    return shape.fillet(radius, edges)


@registry.register("chamfer")
def apply_chamfer(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    shape = _require_solid(_shape_reference(builder, params.get("target"), "target"), "target")
    length = _positive_number(params, "length", 1)
    length2 = None
    if params.get("length2") is not None and params.get("angle") is not None:
        raise ValueError("Use either 'length2' or 'angle', not both.")
    if params.get("length2") is not None:
        length2 = _positive_number(params, "length2", length)
    if params.get("angle") is not None:
        angle = _number(params, "angle", 45)
        if not 0 < angle < 90:
            raise ValueError("'angle' must be between 0 and 90 degrees.")
        length2 = length * math.tan(math.radians(angle))
    edges = _selected_edges(shape, params)
    if not edges:
        raise ValueError("No edges matched the selection.")
    return shape.chamfer(length, length2, edges)


def _hole_common(builder: ModelBuilder, params: Mapping[str, Any], counterbore: bool) -> Any:
    target = _require_solid(_shape_reference(builder, params.get("target"), "target"), "target")
    location = _vector(params.get("location", [0, 0, 0]), "location")
    direction = Vector(*_vector(params.get("direction", [0, 0, -1]), "direction"))
    if direction.length < GEOMETRY_TOLERANCE:
        raise ValueError("'direction' must not be zero.")
    radius = _positive_number(params, "radius", 1)
    depth = params.get("depth")
    if depth is not None:
        depth = _positive_number(params, "depth", 1)
    if counterbore:
        counterbore_radius = _positive_number(params, "counterbore_radius", radius * 2)
        counterbore_depth = _positive_number(params, "counterbore_depth", radius)
        if counterbore_radius <= radius:
            raise ValueError("'counterbore_radius' must exceed 'radius'.")
    # Holes are drilled along the plane's -Z, so the plane faces against the
    # requested drilling direction.
    hole_plane = Plane(origin=location, z_dir=-direction.normalized())
    with BuildPart() as part:
        insert(target)
        with Locations(hole_plane):
            if counterbore:
                CounterBoreHole(
                    radius,
                    counterbore_radius,
                    counterbore_depth,
                    depth=depth,
                    mode=Mode.SUBTRACT,
                )
            else:
                Hole(radius, depth=depth, mode=Mode.SUBTRACT)
    return part.part


@registry.register("hole")
def apply_hole(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    return _hole_common(builder, params, counterbore=False)


@registry.register("counterbore")
def apply_counterbore(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    return _hole_common(builder, params, counterbore=True)


@registry.register("mirror")
def apply_mirror(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    shape = _require_solid(_shape_reference(builder, params.get("target"), "target"), "target")
    mirrored = mirror(shape, about=_plane(params.get("plane", "XY")))
    return shape.fuse(mirrored)


@registry.register("pattern")
def apply_pattern(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    shape = _require_solid(_shape_reference(builder, params.get("target"), "target"), "target")
    pattern_type = params.get("pattern", "linear")
    if pattern_type == "linear":
        x_count = _count(params, "x_count", 1)
        y_count = _count(params, "y_count", 1)
        x_spacing = _number(params, "x_spacing", 10)
        y_spacing = _number(params, "y_spacing", 10)
        if x_count * y_count > MAX_PATTERN_INSTANCES:
            raise ValueError(f"Patterns may contain at most {MAX_PATTERN_INSTANCES} instances.")
        # Instances start at the original position and step along +X and +Y.
        locations = [
            Location((column * x_spacing, row * y_spacing, 0))
            for row in range(y_count)
            for column in range(x_count)
        ]
        copies = [shape.moved(location) for location in locations]
    elif pattern_type == "polar":
        count = _count(params, "count", 1)
        if count > MAX_PATTERN_INSTANCES:
            raise ValueError(f"Patterns may contain at most {MAX_PATTERN_INSTANCES} instances.")
        locations = PolarLocations(
            _positive_number(params, "pattern_radius", 10),
            count,
            _number(params, "start_angle", 0),
            _number(params, "angular_range", 360),
            rotate=_boolean(params, "rotate", True),
        )
        copies = [shape.located(location) for location in locations]
    else:
        raise ValueError("'pattern' must be linear or polar.")
    return _fuse_all(copies)


def _default_feature_tree() -> list[dict[str, Any]]:
    return [
        {
            "type": "sketch",
            "id": "base_profile",
            "params": {
                "plane": "XY",
                "entities": [{"type": "rectangle", "width": 50, "height": 30}],
            },
        },
        {
            "type": "extrude",
            "params": {"profile": "base_profile", "distance": 20},
        },
        {"type": "fillet", "params": {"radius": 2}},
    ]


def _emit(result: dict[str, Any], stream: Any = None) -> None:
    stream = stream or sys.stdout
    stream.write(json.dumps(result, separators=(",", ":")))
    stream.write("\n")
    stream.flush()


def serve(requests: Any, responses: Any) -> None:
    """Answers newline-delimited JSON requests until the input closes.

    Each request is {"id", "op", "features", ...}; "op" is "compile" (the
    default), "export_step" (with "step", the output path) or "measure" (with
    "selection"). Each response is one JSON line carrying the same "id". The
    process stays alive between requests, so the CAD libraries are imported
    once and earlier feature results are reused through the BuildCache.
    """
    cache = BuildCache()
    for line in requests:
        if not line.strip():
            continue
        request_id = None
        try:
            request = json.loads(line)
            if not isinstance(request, Mapping):
                raise ValueError("Request must be an object.")
            request_id = request.get("id")
            operation = request.get("op", "compile")
            features = request.get("features")
            builder = ModelBuilder(cache)
            if operation == "compile":
                result = builder.compile(features)
            elif operation == "export_step":
                step = request.get("step")
                if not isinstance(step, str) or not step:
                    raise ValueError("'step' must be an output path.")
                result = builder.compile(features, export_step_path=step, include_mesh=False)
            elif operation == "measure":
                result = builder.measure(features, request.get("selection"))
            else:
                raise ValueError(f"Unknown operation: '{operation}'.")
        except json.JSONDecodeError as error:
            result = {"success": False, "error": f"Invalid JSON: {error.msg}"}
        except Exception as error:
            result = {"success": False, "error": str(error) or type(error).__name__}
        result["id"] = request_id
        _emit(result, responses)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compile a Paralogic feature tree.")
    parser.add_argument("--step", help="also export the model to this STEP file")
    parser.add_argument(
        "--serve",
        action="store_true",
        help="keep running and answer newline-delimited JSON requests on stdin",
    )
    args = parser.parse_args(argv)
    if args.serve:
        # Only protocol messages may reach stdout; anything a library prints
        # goes to stderr instead.
        responses = sys.stdout
        sys.stdout = sys.stderr
        serve(sys.stdin, responses)
        return 0
    try:
        input_data = sys.stdin.read()
        feature_tree = json.loads(input_data) if input_data.strip() else _default_feature_tree()
    except json.JSONDecodeError as error:
        _emit({"success": False, "error": f"Invalid JSON: {error.msg}"})
        return 1
    result = ModelBuilder().compile(feature_tree, export_step_path=args.step)
    _emit(result)
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    raise SystemExit(main())
