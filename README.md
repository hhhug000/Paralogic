# Paralogic
Parametric CAD

Paralogic has three parts:

- `worker/builder.py` compiles a JSON feature tree into a solid with
  [build123d](https://github.com/gumyr/build123d) and returns a triangle mesh.
- `cmd/server` is a Go API that keeps a pool of long-running workers.
- `web/` is a React + Three.js viewer.

## Setup

Create a virtual environment named `.venv` in the repository root; the server
uses it automatically.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r worker/requirements.txt      # Linux / macOS
.venv\Scripts\python -m pip install -r worker\requirements.txt  # Windows
```

If Python reports `ModuleNotFoundError: No module named 'OCP'` after installation,
remove the unrelated package that uses the conflicting `ocp` package name and
reinstall the worker dependencies:

```sh
python -m pip uninstall -y ocp-windows-amd64
python -m pip install --force-reinstall -r worker/requirements.txt
```

Install the frontend dependencies:

```sh
cd web
npm install
```

## Running

Start the Go API (from anywhere inside the repository):

```sh
go run ./cmd/server
```

In a second terminal, start the Vite development server and open
`http://localhost:5173`:

```sh
cd web
npm run dev
```

For a standalone build, run `npm run build` in `web/` and then open
`http://localhost:8080` while the Go server is running.

### Server options

| Flag | Environment variable | Default |
| --- | --- | --- |
| `-addr` | `PARALOGIC_ADDR` | `127.0.0.1:8080` (local only) |
| `-root` | `PARALOGIC_ROOT` | the directory containing `worker/builder.py`, searched upward from the working directory |
| `-python` | `PARALOGIC_PYTHON` | `.venv` in the root, then `python3`, then `python` |
| `-timeout` | | `60s` per request; the worker is killed (and later replaced) after this or when the client disconnects |
| `-workers` | | number of CPUs; maximum number of worker processes and simultaneous builds |

### Workers and rebuild speed

Each worker is a `python worker/builder.py --serve` process that stays alive
between requests, so Python and the CAD libraries are loaded once. One worker
is started with the server; more are started on demand up to `-workers`.

Workers cache the result of every feature, keyed by a hash of the feature tree
up to that feature. Changing a feature rebuilds only that feature and the ones
after it; an unchanged tree is answered from the cache, including its mesh.
`metrics` reports `build_ms`, `mesh_ms`, `features` and `cached_features`.

Meshes are sent as base64-encoded little-endian binary arrays
(`"encoding": "base64-le"`), which the viewer turns directly into typed arrays.
The tessellation tolerance scales with the model's size.

The worker protocol is one JSON object per line on stdin and stdout:
`{"id", "op", "features", ...}` where `op` is `compile`, `export_step` (with
`step`, an output path) or `measure` (with `selection`). Each reply carries the
same `id`.

### API

- `POST /api/compile` with `{"features": [...]}` returns
  `{"success": true, "metrics": {...}, "mesh": {"vertices", "indices", "topology"}}`
  or `{"success": false, "error": "..."}`. `topology` lists, per CAD face, its
  triangle and vertex ranges, boundary edges, surface type, area and radius,
  and per edge its polyline, kind (curve, line or seam), type, length, radius
  and end vertices.
- `POST /api/measure` with `{"features": [...], "selection": [{"kind": "face" | "edge" | "vertex" | "midpoint", "id": n}, ...]}`;
  datum planes are `{"kind": "plane", "id": "XY" | "XZ" | "YZ"}` (treated as
  infinite) and the origin is `{"kind": "origin", "id": 0}`,
  describes each selected item using exact kernel geometry (type, length,
  area, radius, normal, position). For two items it also returns the minimum
  `distance` (`value`, `from`, `to`, `delta`) and, for lines and planes, the
  `angle` in degrees.
- `POST /api/export/step` with `{"features": [...]}` downloads the model as a STEP file.
- `GET /api/health` returns `{"status": "ok"}`.

The worker can also be run directly:

```sh
echo '[{"type": "box", "params": {}}]' | python worker/builder.py --step model.step
```

## Feature tree

A feature tree is a list of nodes `{"type", "id"?, "body"?, "params"}`.
Features that take a `target`, `profile`, `tool`, `section` or `path` refer to
an earlier feature's `id`; when it is omitted, the previous feature is used.

Each solid belongs to a `body` (default `"main"`). Separate bodies are returned
together. When a feature uses another body's solid, for example as a union
tool, that body is merged and no longer shown separately. Sketches and paths
are construction geometry and are never part of the output.

| Type | Parameters |
| --- | --- |
| `sketch` | `plane` (`XY`, `XZ`, `YZ`), `entities` (see below) |
| `path` | `entities`: `line` (`start`, `end`) or `spline` (`points`); points are 2D or 3D |
| `extrude` | `profile`, `distance`, `symmetric` |
| `revolve` | `profile`, `axis` (`X`, `Y`, `Z`), `angle`; the axis must lie in the profile's plane and the profile must not cross it |
| `sweep` | `section`, `path`, `frenet` |
| `loft` | `profiles` (list of sketch ids) |
| `box` | `length`, `width`, `height` |
| `cylinder` | `radius`, `height` |
| `sphere` | `radius` |
| `union`, `cut`, `intersect` | `target`, `tool` |
| `transform` | `target`, `translation`, Euler `rotation` in degrees |
| `fillet` | `target`, `radius`, edge selection |
| `chamfer` | `target`, `length`, and optionally `length2` or `angle`, edge selection |
| `hole` | `target`, `location`, `radius`, `depth` (through if omitted), `direction` (default `[0, 0, -1]`) |
| `counterbore` | as `hole`, plus `counterbore_radius`, `counterbore_depth` |
| `mirror` | `target`, `plane`; the mirrored copy is fused with the original |
| `pattern` | `target`, `pattern`: `linear` (`x_count`, `y_count`, `x_spacing`, `y_spacing`; copies start at the original and step along +X/+Y) or `polar` (`count`, `pattern_radius`, `start_angle`, `angular_range`, `rotate`); copies are fused, up to 1000 |

Sketch entities:

- `rectangle` (`width`, `height`, `center`) and `circle` (`radius`, `center`)
  each add a closed region.
- `line` (`start`, `end`), `arc` (`start`, `end`, `radius`) and `spline`
  (`points`) are joined into one wire, which must form a single closed loop.

Edge selection uses either `edge_selector` (`all`, `X`, `Y`, `Z`, `horizontal`,
`vertical`) or `edge_indices`. Edge indexes are zero-based and ordered by edge
center (X, then Y, then Z), so they stay the same between builds.

Coordinates are Z-up, as in build123d: `XY` is the Top plane, `XZ` the Front
plane and `YZ` the Right plane.

Examples:

```json
{"type": "sketch", "id": "profile", "params": {
  "plane": "XZ",
  "entities": [{"type": "rectangle", "width": 4, "height": 20, "center": [10, 0]}]
}}
{"type": "revolve", "params": {"profile": "profile", "axis": "Z", "angle": 360}}
{"type": "chamfer", "params": {
  "target": "part", "length": 1, "edge_selector": "vertical"
}}
{"type": "counterbore", "params": {
  "target": "part", "location": [0, 0, 5], "radius": 2,
  "counterbore_radius": 4, "counterbore_depth": 2
}}
{"type": "pattern", "params": {
  "target": "part", "pattern": "polar", "pattern_radius": 20, "count": 6
}}
```

## Viewer

### Layout

A dark workspace: a top bar with the document title, a toolbar (Rebuild,
Export STEP), the feature panel on the left, the viewport with the view cube
and its view menu, a floating selection and measurement panel at the bottom right
of the viewport, and a status bar. Colours are CSS custom properties in
`web/src/styles.css` (`:root`) and constants at the top of `web/src/main.jsx`
for the 3D scene.

### Feature tree

The model starts empty. The feature panel has a filter box (by name or type),
a **Features** list that begins with a collapsible **Default geometry** section listing the Origin and the Top (XY), Front (XZ)
and Right (YZ) planes, followed by the model's features, and a collapsible **Parts** section listing
the bodies the model produces. Clicking a default
geometry item selects it in the viewport (hovering highlights it), and items
selected in the viewport are highlighted in the tree. Datums can be measured
without a model.

### Navigation

- The mouse layout follows Fusion: middle drag pans, Shift + middle drag orbits
  about the point under the cursor (shown while orbiting), and the wheel zooms
  towards the cursor. Panning keeps the grabbed point under the cursor.
- Rotation has no stop at the poles. Turntable keeps CAD Z vertical; trackball
  rotates freely (view menu).
- Perspective and orthographic projection keep the same framing when switched.

The view cube (top right) has bevelled faces, edges and corners: click one to
look from that direction, or drag the cube to orbit. Clicking the cube or
choosing a standard view also centres and fits the model (or the datum planes
when the model is empty), wherever the camera was before. The triangle arrows
rotate the view and the curved arrows roll it, by 90° from a standard view and
15° otherwise. The X/Y/Z triad shows the model axes. All other view tools
(standard views, camera, display, section, navigation settings and shortcuts)
are in the menu under the small cube button at the gizmo's bottom right.

### Shortcuts

| Key | Action |
| --- | --- |
| `1`–`7` | Front, back, left, right, top, bottom, isometric |
| `F` | Fit the model |
| `Z` | Zoom to the selection |
| `N` | Look straight at the selected (or hovered) face; again to flip |
| `O` | Toggle perspective / orthographic |
| `D` | Cycle display mode |
| `S` | Toggle the section view |
| `P` | Toggle reference planes |
| `Space`, `Esc` | Clear the selection |

### Display

Display modes are shaded with edges, shaded, hidden line, wireframe and
transparent. Curved faces get silhouette outlines that follow the camera. A
headlight follows the view. The section view cuts along the Top, Front or Right
plane at any offset; by default it removes the half facing the camera, and the
cut surface is shown in colour. The reference planes are not cut.

### Selection, feedback and measurement

Click faces, edges, vertices, straight-edge midpoints, the origin and the
Top, Front and Right datum planes to toggle them in the selection; clicking
empty space clears it. A left drag selects with a box, as in Fusion:
dragging left to right is a window selection (solid box; items entirely
inside), right to left a crossing selection (dashed box; anything the box
touches). Only visible faces, edges, vertices and the origin are picked (datum
planes only by a window around the whole plane), and they are added to the
selection; hold Ctrl while dragging to remove them instead. Model vertices and edges win over the origin, which wins
over model faces, which win over datum planes. Normal to (`N`) also works on a
datum plane. Hovering shows the item's type and
size (for example `Edge 10 · Circle · R 3.00 · L 18.85`). The sidebar measures
the selection with exact kernel geometry; for two items the distance is drawn
in the view. The status bar shows rebuild time, reused features and model
statistics.

Selection uses the real CAD topology sent by the builder (`mesh.topology`), so
face and edge numbers in the selection list are the same indexes accepted by
`edge_indices`. Only the boundary of the face under the pointer is tested, with
pixel tolerances, so hidden edges cannot be picked and picking cost does not
grow with model size.

## Tests

```sh
go test ./...
cd worker && ../.venv/bin/python -m unittest
```
