import base64
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from array import array

from builder import BuildCache, ModelBuilder

BUILDER = Path(__file__).with_name("builder.py")


def compile_tree(tree):
    return ModelBuilder().compile(tree)


TYPECODES = {
    "vertices": "f",
    "indices": "I",
    "edge_points": "f",
    "edge_kinds": "B",
    "edge_vertices": "i",
    "face_areas": "f",
    "face_radii": "f",
    "edge_lengths": "f",
    "edge_radii": "f",
}


def decode(name, value):
    """Turns a base64 array from the builder back into a Python list."""
    if not isinstance(value, str):
        return value
    values = array(TYPECODES.get(name, "I"))
    values.frombytes(base64.b64decode(value))
    return values.tolist()


def decoded_mesh(mesh):
    result = {name: decode(name, mesh[name]) for name in ("vertices", "indices")}
    result["topology"] = {name: decode(name, value) for name, value in mesh["topology"].items()}
    return result


def box(feature_id="base", body=None, **params):
    node = {"type": "box", "id": feature_id, "params": params}
    if body:
        node["body"] = body
    return node


class BuilderTests(unittest.TestCase):
    def assertSuccess(self, result):
        self.assertTrue(result["success"], result.get("error"))
        return result

    def assertFailure(self, result, fragment):
        self.assertFalse(result["success"])
        self.assertIn(fragment, result["error"])

    def test_box_with_hole(self):
        result = self.assertSuccess(
            compile_tree(
                [
                    box(length=40, width=30, height=10),
                    {"type": "hole", "params": {"target": "base", "location": [0, 0, 5], "radius": 3}},
                ]
            )
        )
        self.assertEqual(result["metrics"]["faces"], 7)
        self.assertAlmostEqual(result["metrics"]["volume"], 12000 - 3.14159265 * 9 * 10, places=2)

    def test_sketch_lines_form_a_face(self):
        tree = [
            {
                "type": "sketch",
                "id": "triangle",
                "params": {
                    "entities": [
                        {"type": "line", "start": [0, 0], "end": [10, 0]},
                        {"type": "line", "start": [10, 0], "end": [10, 10]},
                        {"type": "line", "start": [10, 10], "end": [0, 0]},
                    ]
                },
            },
            {"type": "extrude", "params": {"profile": "triangle", "distance": 5}},
        ]
        result = self.assertSuccess(compile_tree(tree))
        self.assertAlmostEqual(result["metrics"]["volume"], 250, places=4)

    def test_open_sketch_loop_is_rejected(self):
        tree = [
            {
                "type": "sketch",
                "params": {"entities": [{"type": "line", "start": [0, 0], "end": [10, 0]}]},
            }
        ]
        self.assertFailure(compile_tree(tree), "closed loop")

    def test_revolve_requires_axis_in_profile_plane(self):
        tree = [
            {"type": "sketch", "id": "p", "params": {"entities": [{"type": "rectangle"}]}},
            {"type": "revolve", "params": {"profile": "p", "axis": "Z"}},
        ]
        self.assertFailure(compile_tree(tree), "must lie in the profile's plane")

    def test_revolve_rejects_profile_crossing_axis(self):
        tree = [
            {"type": "sketch", "id": "p", "params": {"plane": "XZ", "entities": [{"type": "rectangle"}]}},
            {"type": "revolve", "params": {"profile": "p", "axis": "Z"}},
        ]
        self.assertFailure(compile_tree(tree), "crosses the revolve axis")

    def test_revolve_offset_profile(self):
        tree = [
            {
                "type": "sketch",
                "id": "p",
                "params": {
                    "plane": "XZ",
                    "entities": [{"type": "rectangle", "width": 4, "height": 20, "center": [10, 0]}],
                },
            },
            {"type": "revolve", "params": {"profile": "p", "axis": "Z"}},
        ]
        result = self.assertSuccess(compile_tree(tree))
        self.assertAlmostEqual(result["metrics"]["volume"], 3.14159265 * (144 - 64) * 20, places=2)

    def test_consumed_body_is_not_duplicated(self):
        tree = [
            box("a"),
            {"type": "sphere", "id": "b", "body": "second", "params": {"radius": 3}},
            {"type": "union", "params": {"target": "a", "tool": "b"}},
        ]
        result = self.assertSuccess(compile_tree(tree))
        self.assertEqual(result["metrics"]["faces"], 6)

    def test_separate_bodies_are_combined(self):
        tree = [
            box("a"),
            {"type": "sphere", "id": "b", "body": "second", "params": {"radius": 3}},
            {"type": "transform", "body": "second", "params": {"target": "b", "translation": [20, 0, 0]}},
        ]
        result = self.assertSuccess(compile_tree(tree))
        self.assertEqual(result["metrics"]["faces"], 7)
        self.assertEqual(result["metrics"]["parts"], ["main", "second"])

    def test_sketch_is_not_included_in_model(self):
        tree = [
            box("a"),
            {"type": "sketch", "body": "second", "params": {"entities": [{"type": "circle"}]}},
        ]
        result = self.assertSuccess(compile_tree(tree))
        self.assertEqual(result["metrics"]["faces"], 6)

    def test_sketch_only_tree_is_rejected(self):
        tree = [{"type": "sketch", "params": {"entities": [{"type": "circle"}]}}]
        self.assertFailure(compile_tree(tree), "at least one 3D solid")

    def test_pattern_requires_whole_counts(self):
        tree = [box("a"), {"type": "pattern", "params": {"x_count": 2.9}}]
        self.assertFailure(compile_tree(tree), "whole number")

    def test_pattern_is_limited(self):
        tree = [box("a"), {"type": "pattern", "params": {"x_count": 300, "y_count": 300}}]
        self.assertFailure(compile_tree(tree), "at most")

    def test_pattern_is_fused(self):
        tree = [box("a"), {"type": "pattern", "params": {"x_count": 3, "x_spacing": 5}}]
        result = self.assertSuccess(compile_tree(tree))
        self.assertEqual(result["metrics"]["faces"], 6)
        self.assertAlmostEqual(result["metrics"]["volume"], 2000, places=4)

    def test_negative_edge_index_is_rejected(self):
        tree = [box("a"), {"type": "fillet", "params": {"edge_indices": [-1]}}]
        self.assertFailure(compile_tree(tree), "between 0 and 11")

    def test_boolean_strings_are_rejected(self):
        tree = [
            box("a"),
            {"type": "pattern", "params": {"pattern": "polar", "count": 2, "rotate": "false"}},
        ]
        self.assertFailure(compile_tree(tree), "true or false")

    def test_angle_chamfer(self):
        tree = [box("a"), {"type": "chamfer", "params": {"length": 1, "angle": 30, "edge_indices": [0]}}]
        result = self.assertSuccess(compile_tree(tree))
        self.assertLess(result["metrics"]["volume"], 1000)

    def test_edge_order_is_stable(self):
        first = compile_tree([box("a"), {"type": "fillet", "params": {"edge_indices": [0, 5]}}])
        second = compile_tree([box("a"), {"type": "fillet", "params": {"edge_indices": [0, 5]}}])
        geometry = lambda result: {k: result["metrics"][k] for k in ("faces", "edges", "volume")}
        self.assertEqual(geometry(first), geometry(second))

    def test_hole_direction(self):
        tree = [
            box("a", height=10),
            {
                "type": "hole",
                "params": {"location": [0, 0, -5], "direction": [0, 0, 1], "radius": 1, "depth": 2},
            },
        ]
        result = self.assertSuccess(compile_tree(tree))
        self.assertLess(result["metrics"]["bounding_box"]["min"][2], -4.9)
        self.assertAlmostEqual(result["metrics"]["volume"], 1000 - 3.14159265 * 2, places=2)


class TopologyTests(unittest.TestCase):
    def topology(self, tree):
        result = compile_tree(tree)
        self.assertTrue(result["success"], result.get("error"))
        mesh = decoded_mesh(result["mesh"])
        return mesh, mesh["topology"]

    def test_box_topology(self):
        mesh, topology = self.topology([box()])
        self.assertEqual(len(topology["face_triangle_offsets"]), 7)
        self.assertEqual(topology["face_triangle_offsets"][-1], len(mesh["indices"]) // 3)
        self.assertEqual(topology["face_vertex_offsets"][-1], len(mesh["vertices"]) // 3)
        self.assertEqual(len(topology["edge_kinds"]), 12)
        self.assertEqual(set(topology["edge_kinds"]), {1})
        self.assertEqual(len(topology["vertices"]), 8 * 3)
        # Every box face is bounded by exactly four edges and every edge
        # borders exactly two faces.
        offsets = topology["face_edge_offsets"]
        self.assertEqual([b - a for a, b in zip(offsets, offsets[1:])], [4] * 6)
        self.assertEqual(sorted(topology["face_edges"]), sorted(list(range(12)) * 2))

    def test_triangles_stay_inside_their_face_vertex_range(self):
        mesh, topology = self.topology(
            [box(length=40, width=30, height=10), {"type": "hole", "params": {"radius": 3, "location": [0, 0, 5]}}]
        )
        triangles = topology["face_triangle_offsets"]
        vertices = topology["face_vertex_offsets"]
        for face in range(len(triangles) - 1):
            corners = mesh["indices"][triangles[face] * 3 : triangles[face + 1] * 3]
            self.assertTrue(all(vertices[face] <= corner < vertices[face + 1] for corner in corners))

    def test_hole_seam_is_marked(self):
        _, topology = self.topology(
            [box(length=40, width=30, height=10), {"type": "hole", "params": {"radius": 3, "location": [0, 0, 5]}}]
        )
        self.assertEqual(topology["edge_kinds"].count(2), 1)
        self.assertEqual(topology["edge_kinds"].count(0), 2)
        seam = topology["edge_kinds"].index(2)
        self.assertNotIn(seam, topology["face_edges"])

    def test_edge_numbering_matches_edge_indices(self):
        _, topology = self.topology([box()])
        points = topology["edge_points"]
        offsets = topology["edge_point_offsets"]
        start, end = offsets[3], offsets[4]
        edge = points[start * 3 : end * 3]
        center = [(edge[i] + edge[i + 3]) / 2 for i in range(3)]
        from builder import _sorted_edges
        from build123d import Box

        expected = _sorted_edges(Box(10, 10, 10))[3].center()
        self.assertAlmostEqual(center[0], expected.X, places=5)
        self.assertAlmostEqual(center[1], expected.Y, places=5)
        self.assertAlmostEqual(center[2], expected.Z, places=5)

    def test_face_and_edge_descriptions(self):
        _, topology = self.topology(
            [box(length=40, width=30, height=10), {"type": "hole", "params": {"radius": 3, "location": [0, 0, 5]}}]
        )
        self.assertEqual(topology["face_types"].count("cylinder"), 1)
        cylinder = topology["face_types"].index("cylinder")
        self.assertAlmostEqual(topology["face_radii"][cylinder], 3, places=5)
        circles = [i for i, kind in enumerate(topology["edge_types"]) if kind == "circle"]
        self.assertEqual(len(circles), 2)
        for edge in circles:
            self.assertAlmostEqual(topology["edge_radii"][edge], 3, places=5)
            self.assertAlmostEqual(topology["edge_lengths"][edge], 6 * 3.14159265, places=4)


class CacheTests(unittest.TestCase):
    tree = [
        box("base", length=40, width=30, height=10),
        {"type": "hole", "params": {"target": "base", "radius": 3, "location": [0, 0, 5]}},
        {"type": "fillet", "params": {"radius": 1, "edge_selector": "vertical"}},
    ]

    def test_unchanged_prefix_is_reused(self):
        cache = BuildCache()
        first = ModelBuilder(cache).compile(self.tree)
        self.assertEqual(first["metrics"]["cached_features"], 0)
        edited = self.tree[:2] + [{"type": "fillet", "params": {"radius": 2, "edge_selector": "vertical"}}]
        second = ModelBuilder(cache).compile(edited)
        self.assertTrue(second["success"], second.get("error"))
        self.assertEqual(second["metrics"]["cached_features"], 2)
        self.assertLess(second["metrics"]["volume"], first["metrics"]["volume"])

    def test_cached_result_matches_fresh_build(self):
        cache = BuildCache()
        ModelBuilder(cache).compile(self.tree)
        cached = ModelBuilder(cache).compile(self.tree)
        fresh = ModelBuilder().compile(self.tree)
        self.assertEqual(cached["metrics"]["cached_features"], 3)
        self.assertEqual(cached["mesh"], fresh["mesh"])
        self.assertAlmostEqual(cached["metrics"]["volume"], fresh["metrics"]["volume"])

    def test_editing_an_early_feature_invalidates_later_ones(self):
        cache = BuildCache()
        ModelBuilder(cache).compile(self.tree)
        edited = [box("base", length=50, width=30, height=10)] + self.tree[1:]
        result = ModelBuilder(cache).compile(edited)
        self.assertEqual(result["metrics"]["cached_features"], 0)
        self.assertGreater(result["metrics"]["bounding_box"]["max"][0], 24.9)

    def test_failed_feature_is_not_cached(self):
        cache = BuildCache()
        bad = self.tree[:2] + [{"type": "fillet", "params": {"radius": 50}}]
        self.assertFalse(ModelBuilder(cache).compile(bad)["success"])
        self.assertFalse(ModelBuilder(cache).compile(bad)["success"])


class MeasureTests(unittest.TestCase):
    tree = [box(length=40, width=30, height=10), {"type": "hole", "params": {"radius": 3, "location": [0, 0, 5]}}]

    def measure(self, *selection):
        result = ModelBuilder().measure(self.tree, [{"kind": k, "id": i} for k, i in selection])
        self.assertTrue(result["success"], result.get("error"))
        return result

    def face_of_type(self, kind, normal_z=None):
        mesh = decoded_mesh(compile_tree(self.tree)["mesh"])
        for index, face_type in enumerate(mesh["topology"]["face_types"]):
            if face_type != kind:
                continue
            if normal_z is None:
                return index
            item = self.measure(("face", index))["items"][0]
            if abs(item["normal"][2] - normal_z) < 1e-6:
                return index
        raise AssertionError(kind)

    def test_parallel_faces_distance(self):
        top = self.face_of_type("plane", 1)
        bottom = self.face_of_type("plane", -1)
        result = self.measure(("face", top), ("face", bottom))
        self.assertAlmostEqual(result["distance"]["value"], 10)
        self.assertAlmostEqual(result["angle"], 0)

    def test_cylinder_radius(self):
        item = self.measure(("face", self.face_of_type("cylinder")))["items"][0]
        self.assertAlmostEqual(item["radius"], 3)

    def test_reference_plane_distance_and_angle(self):
        top = self.face_of_type("plane", 1)
        result = self.measure(("plane", "XY"), ("face", top))
        self.assertEqual(result["items"][0]["normal"], [0, 0, 1])
        self.assertAlmostEqual(result["distance"]["value"], 5)
        self.assertAlmostEqual(result["angle"], 0)
        front = self.measure(("plane", "XZ"))["items"][0]
        self.assertEqual(front["normal"], [0, -1, 0])

    def test_origin_distance(self):
        result = self.measure(("origin", 0), ("vertex", 0))
        self.assertAlmostEqual(result["distance"]["value"], (20**2 + 15**2 + 5**2) ** 0.5)

    def test_datums_measure_without_a_model(self):
        result = ModelBuilder().measure([], [{"kind": "origin", "id": 0}, {"kind": "plane", "id": "YZ"}])
        self.assertTrue(result["success"], result.get("error"))
        self.assertAlmostEqual(result["distance"]["value"], 0)
        planes = ModelBuilder().measure([], [{"kind": "plane", "id": "XY"}, {"kind": "plane", "id": "XZ"}])
        self.assertAlmostEqual(planes["angle"], 90)
        self.assertFalse(ModelBuilder().measure([], [{"kind": "face", "id": 0}])["success"])

    def test_unknown_reference_plane(self):
        result = ModelBuilder().measure(self.tree, [{"kind": "plane", "id": "AB"}])
        self.assertFalse(result["success"])

    def test_invalid_selection(self):
        result = ModelBuilder().measure(self.tree, [{"kind": "edge", "id": 999}])
        self.assertFalse(result["success"])


class ServeTests(unittest.TestCase):
    def test_one_process_answers_many_requests(self):
        tree = [box(), {"type": "fillet", "params": {"radius": 1}}]
        requests = [
            {"id": 1, "features": tree},
            {"id": 2, "features": tree},
            {"id": 3, "op": "measure", "features": tree, "selection": [{"kind": "vertex", "id": 0}]},
            {"id": 4, "op": "nope", "features": tree},
            "not json",
        ]
        stdin = "\n".join(r if isinstance(r, str) else json.dumps(r) for r in requests) + "\n"
        completed = subprocess.run(
            [sys.executable, str(BUILDER), "--serve"],
            input=stdin,
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        responses = [json.loads(line) for line in completed.stdout.splitlines()]
        self.assertEqual([r["id"] for r in responses], [1, 2, 3, 4, None])
        self.assertTrue(responses[0]["success"])
        self.assertEqual(responses[1]["metrics"]["cached_features"], 2)
        self.assertEqual(responses[2]["items"][0]["kind"], "vertex")
        self.assertIn("Unknown operation", responses[3]["error"])
        self.assertIn("Invalid JSON", responses[4]["error"])

    def test_export_step_operation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.step"
            request = {"id": 7, "op": "export_step", "features": [box()], "step": str(path)}
            completed = subprocess.run(
                [sys.executable, str(BUILDER), "--serve"],
                input=json.dumps(request) + "\n",
                capture_output=True,
                text=True,
                timeout=120,
            )
            response = json.loads(completed.stdout)
            self.assertTrue(response["success"], response.get("error"))
            self.assertNotIn("mesh", response)
            self.assertIn("ISO-10303-21", path.read_text())


class CommandLineTests(unittest.TestCase):
    def run_builder(self, stdin, *args):
        return subprocess.run(
            [sys.executable, str(BUILDER), *args],
            input=stdin,
            capture_output=True,
            text=True,
            timeout=120,
        )

    def test_default_tree_does_not_write_step(self):
        completed = self.run_builder("")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertTrue(result["success"])
        self.assertNotIn("step_file", result)

    def test_step_export(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.step"
            completed = self.run_builder(json.dumps([box()]), "--step", str(path))
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIn("ISO-10303-21", path.read_text())

    def test_invalid_json(self):
        completed = self.run_builder("{")
        self.assertEqual(completed.returncode, 1)
        self.assertIn("Invalid JSON", json.loads(completed.stdout)["error"])


if __name__ == "__main__":
    unittest.main()
