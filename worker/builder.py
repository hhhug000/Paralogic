from __future__ import annotations

import json
import sys
import tempfile
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from build123d import (
    Box,
    BuildPart,
    BuildLine,
    BuildSketch,
    Circle,
    Compound,
    Cylinder,
    Axis,
    CounterBoreHole,
    GridLocations,
    Hole,
    Location,
    Line,
    Locations,
    Mode,
    PolarLocations,
    Plane,
    RadiusArc,
    Rectangle,
    Sphere,
    Spline,
    Vector,
    export_step,
    extrude,
    insert,
    loft,
    mirror,
    revolve,
    sweep,
)

FeatureHandler = Callable[["ModelBuilder", Mapping[str, Any]], Any]


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


def _number(params: Mapping[str, Any], name: str, default: float) -> float:
    value = params.get(name, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"'{name}' must be a number.")
    if value != value or value in (float("inf"), float("-inf")):
        raise ValueError(f"'{name}' must be finite.")
    return float(value)


def _positive_number(params: Mapping[str, Any], name: str, default: float) -> float:
    value = _number(params, name, default)
    if value <= 0:
        raise ValueError(f"'{name}' must be greater than zero.")
    return value


def _point(value: Any, name: str) -> tuple[float, float]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)) or len(value) != 2:
        raise ValueError(f"'{name}' must contain exactly two numbers.")
    if any(isinstance(item, bool) or not isinstance(item, (int, float)) for item in value):
        raise ValueError(f"'{name}' must contain only numbers.")
    return float(value[0]), float(value[1])


def _vector(value: Any, name: str) -> tuple[float, float, float]:
    if (
        not isinstance(value, Sequence)
        or isinstance(value, (str, bytes))
        or len(value) != 3
        or any(isinstance(item, bool) or not isinstance(item, (int, float)) for item in value)
    ):
        raise ValueError(f"'{name}' must contain exactly three numbers.")
    return float(value[0]), float(value[1]), float(value[2])


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


def _shape_value(value: Any) -> Any:
    if value is None:
        raise ValueError("Feature produced no result.")
    if hasattr(value, "val") and callable(value.val):
        value = value.val()
    if value is None:
        raise ValueError("Feature produced no result.")
    return value


def _shape_reference(builder: ModelBuilder, reference: Any, name: str) -> Any:
    if reference is None:
        return _shape_value(builder.context)
    if not isinstance(reference, str) or not reference:
        raise ValueError(f"'{name}' must be a non-empty feature id.")
    if reference not in builder.results:
        raise ValueError(f"Feature '{reference}' was not found.")
    return _shape_value(builder.results[reference])


def _selected_edges(shape: Any, params: Mapping[str, Any]) -> list[Any]:
    edges = list(shape.edges())
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
        try:
            return [edges[index] for index in indices]
        except IndexError as error:
            raise ValueError("An edge index is out of range.") from error
    if selector is None or selector == "all":
        return edges
    if selector not in {"X", "Y", "Z", "horizontal", "vertical"}:
        raise ValueError("'edge_selector' must be all, X, Y, Z, horizontal, or vertical.")
    selected = []
    for edge in edges:
        try:
            tangent = edge.tangent_at(0.5)
            components = [abs(float(tangent.X)), abs(float(tangent.Y)), abs(float(tangent.Z))]
            dominant = "XYZ"[components.index(max(components))]
            if selector in {"X", "Y", "Z"} and dominant == selector:
                selected.append(edge)
            elif selector == "horizontal" and dominant in {"X", "Y"}:
                selected.append(edge)
            elif selector == "vertical" and dominant == "Z":
                selected.append(edge)
        except Exception:
            continue
    return selected


class ModelBuilder:
    def __init__(self) -> None:
        self.context: Any = None
        self.sketches: dict[str, Any] = {}
        self.results: dict[str, Any] = {}
        self.bodies: dict[str, Any] = {}

    def compile(
        self,
        feature_tree: Sequence[Mapping[str, Any]],
        export_step_path: str | Path | None = None,
    ) -> dict[str, Any]:
        try:
            if not isinstance(feature_tree, Sequence) or isinstance(feature_tree, (str, bytes)):
                raise ValueError("Feature tree must be a list of feature objects.")
            if not feature_tree:
                raise ValueError("Feature tree is empty.")

            self.context = None
            self.sketches = {}
            self.results = {}
            self.bodies = {}

            for index, node in enumerate(feature_tree):
                if not isinstance(node, Mapping):
                    raise ValueError(f"Feature {index} must be an object.")
                feature_type = node.get("type")
                if not isinstance(feature_type, str) or not feature_type:
                    raise ValueError(f"Feature {index} is missing a valid 'type'.")
                params = node.get("params", {})
                if not isinstance(params, Mapping):
                    raise ValueError(f"Feature {index} params must be an object.")

                feature_id = node.get("id")
                if feature_id is not None and (
                    not isinstance(feature_id, str) or not feature_id
                ):
                    raise ValueError(f"Feature {index} has an invalid 'id'.")
                if feature_id in self.results:
                    raise ValueError(f"Duplicate feature id: '{feature_id}'.")

                try:
                    result = registry.get(feature_type)(self, params)
                except Exception as error:
                    raise ValueError(
                        f"Feature {index} ('{feature_type}') failed: {error}"
                    ) from error

                self.context = result
                if feature_id:
                    self.results[feature_id] = result
                    if feature_type == "sketch":
                        self.sketches[feature_id] = result
                body_id = node.get("body", "main")
                if not isinstance(body_id, str) or not body_id:
                    raise ValueError(f"Feature {index} has an invalid 'body'.")
                self.bodies[body_id] = result

            target_shape = _shape_value(self.context)
            if len(self.bodies) > 1:
                target_shape = Compound([_shape_value(body) for body in self.bodies.values()])
            if not hasattr(target_shape, "tessellate") or not callable(target_shape.tessellate):
                raise ValueError("The final feature must produce a 3D shape.")

            if export_step_path is not None:
                export_path = Path(export_step_path)
                export_path.parent.mkdir(parents=True, exist_ok=True)
                export_step(target_shape, str(export_path))

            tessellation = target_shape.tessellate(tolerance=0.1)
            if not tessellation or len(tessellation) != 2:
                raise ValueError("Tessellation produced no mesh.")
            points, triangles = tessellation
            if not points or not triangles:
                raise ValueError("Tessellation produced zero vertices or triangles.")

            vertices = [
                coordinate
                for point in points
                for coordinate in (float(point.X), float(point.Y), float(point.Z))
            ]
            indices = [
                index
                for triangle in triangles
                for index in (int(triangle[0]), int(triangle[1]), int(triangle[2]))
            ]
            bbox = target_shape.bounding_box()

            return {
                "success": True,
                "metrics": {
                    "faces": len(target_shape.faces()),
                    "edges": len(target_shape.edges()),
                    "bounding_box": {
                        "min": [float(bbox.min.X), float(bbox.min.Y), float(bbox.min.Z)],
                        "max": [float(bbox.max.X), float(bbox.max.Y), float(bbox.max.Z)],
                    },
                },
                "mesh": {"vertices": vertices, "indices": indices},
            }
        except Exception as error:
            return {"success": False, "error": str(error)}


@registry.register("sketch")
def build_sketch(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    plane_name = params.get("plane", "XY")
    sketch_plane = _plane(plane_name)
    entities = params.get("entities", [])
    if not isinstance(entities, Sequence) or isinstance(entities, (str, bytes)):
        raise ValueError("'entities' must be a list.")

    with BuildSketch(sketch_plane) as sketch_builder:
        for index, entity in enumerate(entities):
            if not isinstance(entity, Mapping):
                raise ValueError(f"Sketch entity {index} must be an object.")
            entity_type = entity.get("type")
            if entity_type == "rectangle":
                Rectangle(
                    _positive_number(entity, "width", 10),
                    _positive_number(entity, "height", 10),
                )
            elif entity_type == "circle":
                Circle(_positive_number(entity, "radius", 5))
            elif entity_type == "line":
                Line(_point(entity.get("start", [0, 0]), "start"),
                     _point(entity.get("end", [10, 10]), "end"))
            elif entity_type == "arc":
                RadiusArc(
                    _point(entity.get("start", [5, 0]), "start"),
                    _point(entity.get("end", [0, 5]), "end"),
                    _positive_number(entity, "radius", 5),
                )
            elif entity_type == "spline":
                raw_points = entity.get("points", [])
                if not isinstance(raw_points, Sequence) or len(raw_points) < 2:
                    raise ValueError("Spline requires at least two points.")
                Spline([Vector(*_point(point, "points")) for point in raw_points])
            elif entity_type == "point":
                raise ValueError(
                    "Point entities are construction geometry and cannot form a solid profile."
                )
            else:
                raise ValueError(f"Unsupported sketch entity: '{entity_type}'.")
    return sketch_builder.sketch


@registry.register("path")
def build_path(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    entities = params.get("entities", [])
    if not isinstance(entities, Sequence) or isinstance(entities, (str, bytes)) or not entities:
        raise ValueError("'entities' must be a non-empty list.")
    with BuildLine() as line_builder:
        for index, entity in enumerate(entities):
            if not isinstance(entity, Mapping):
                raise ValueError(f"Path entity {index} must be an object.")
            if entity.get("type") == "line":
                Line(
                    _point(entity.get("start", [0, 0]), "start"),
                    _point(entity.get("end", [10, 0]), "end"),
                )
            elif entity.get("type") == "spline":
                raw_points = entity.get("points", [])
                if not isinstance(raw_points, Sequence) or len(raw_points) < 2:
                    raise ValueError("Spline paths require at least two points.")
                Spline([Vector(*_point(point, "points")) for point in raw_points])
            else:
                raise ValueError("Path entities currently support line and spline.")
    return line_builder.wire()


@registry.register("extrude")
def apply_extrude(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    profile = _shape_reference(builder, params.get("profile"), "profile")
    distance = _number(params, "distance", 10)
    if distance == 0:
        raise ValueError("'distance' must not be zero.")
    symmetric = params.get("symmetric", False)
    if not isinstance(symmetric, bool):
        raise ValueError("'symmetric' must be a boolean.")
    with BuildPart() as part:
        extrude(profile, amount=distance, both=symmetric)
    return part.part


@registry.register("transform")
def apply_transform(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    shape = _shape_reference(builder, params.get("target"), "target")
    translation = _vector(params.get("translation", [0, 0, 0]), "translation")
    rotation = _vector(params.get("rotation", [0, 0, 0]), "rotation")
    return shape.moved(Location(translation, rotation))


@registry.register("revolve")
def apply_revolve(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    profile = _shape_reference(builder, params.get("profile"), "profile")
    angle = _number(params, "angle", 360)
    if angle == 0 or abs(angle) > 360:
        raise ValueError("'angle' must be non-zero and no greater than 360 degrees.")
    with BuildPart() as part:
        revolve(profile, axis=_axis(params.get("axis", "Z")), revolution_arc=angle)
    return part.part


@registry.register("sweep")
def apply_sweep(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    section = _shape_reference(builder, params.get("section"), "section")
    path = _shape_reference(builder, params.get("path"), "path")
    with BuildPart() as part:
        sweep(
            sections=section,
            path=path,
            is_frenet=bool(params.get("frenet", False)),
        )
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


def _boolean_operation(
    builder: ModelBuilder, params: Mapping[str, Any], operation: str
) -> Any:
    target = _shape_reference(builder, params.get("target"), "target")
    tool = _shape_reference(builder, params.get("tool"), "tool")
    try:
        return getattr(target, operation)(tool)
    except AttributeError as error:
        raise ValueError(f"Boolean operation requires compatible 3D shapes: {error}") from error


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
    shape = _shape_reference(builder, params.get("target"), "target")
    radius = _positive_number(params, "radius", 1)
    edges = _selected_edges(shape, params)
    if not edges:
        raise ValueError("Cannot fillet a shape with no edges.")
    return shape.fillet(radius, edges)


@registry.register("chamfer")
def apply_chamfer(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    shape = _shape_reference(builder, params.get("target"), "target")
    length = _positive_number(params, "length", 1)
    length2 = params.get("length2")
    if length2 is not None:
        length2 = _positive_number(params, "length2", length)
    angle = params.get("angle")
    if angle is not None:
        angle = _number(params, "angle", 45)
        if not 0 < angle < 90:
            raise ValueError("'angle' must be between 0 and 90 degrees.")
    edges = _selected_edges(shape, params)
    if not edges:
        raise ValueError("Cannot chamfer a shape with no selected edges.")
    if angle is not None:
        raise ValueError("Angle-based chamfers are not supported for direct shape operations.")
    return shape.chamfer(length, length2, edges)


def _hole_common(builder: ModelBuilder, params: Mapping[str, Any], counterbore: bool) -> Any:
    target = _shape_reference(builder, params.get("target"), "target")
    location = _vector(params.get("location", [0, 0, 0]), "location")
    radius = _positive_number(params, "radius", 1)
    depth = params.get("depth")
    if depth is not None:
        depth = _positive_number(params, "depth", 1)
    with BuildPart() as part:
        insert(target)
        with Locations(location):
            if counterbore:
                counterbore_radius = _positive_number(params, "counterbore_radius", radius * 2)
                counterbore_depth = _positive_number(params, "counterbore_depth", radius)
                if counterbore_radius <= radius:
                    raise ValueError("'counterbore_radius' must exceed 'radius'.")
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
    shape = _shape_reference(builder, params.get("target"), "target")
    mirrored = mirror(shape, about=_plane(params.get("plane", "XY")))
    return shape.fuse(mirrored)


@registry.register("pattern")
def apply_pattern(builder: ModelBuilder, params: Mapping[str, Any]) -> Any:
    shape = _shape_reference(builder, params.get("target"), "target")
    pattern_type = params.get("pattern", "linear")
    if pattern_type == "linear":
        x_count = int(_positive_number(params, "x_count", 1))
        y_count = int(_positive_number(params, "y_count", 1))
        x_spacing = _number(params, "x_spacing", 10)
        y_spacing = _number(params, "y_spacing", 10)
        if x_count < 1 or y_count < 1:
            raise ValueError("Pattern counts must be positive integers.")
        locations = GridLocations(x_spacing, y_spacing, x_count, y_count)
    elif pattern_type == "polar":
        count = int(_positive_number(params, "count", 1))
        if count < 1:
            raise ValueError("'count' must be a positive integer.")
        locations = PolarLocations(
            _positive_number(params, "pattern_radius", 10),
            count,
            _number(params, "start_angle", 0),
            _number(params, "angular_range", 360),
            rotate=bool(params.get("rotate", True)),
        )
    else:
        raise ValueError("'pattern' must be linear or polar.")
    return Compound([shape.located(location) for location in locations])


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


def main() -> int:
    try:
        input_data = sys.stdin.read()
        feature_tree = json.loads(input_data) if input_data.strip() else _default_feature_tree()
        with tempfile.NamedTemporaryFile(suffix=".step", delete=False) as step_file:
            step_path = step_file.name
        result = ModelBuilder().compile(feature_tree, export_step_path=step_path)
        if result.get("success"):
            result["step_file"] = step_path
        print(json.dumps(result, indent=2))
        return 0 if result.get("success") else 1
    except json.JSONDecodeError as error:
        print(json.dumps({"success": False, "error": f"Invalid JSON: {error.msg}"}))
        return 1
    except Exception as error:
        print(json.dumps({"success": False, "error": str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
