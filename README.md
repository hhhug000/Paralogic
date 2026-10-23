# Paralogic
Parametric CAD

## Worker setup

Install the worker dependencies with:

```powershell
python -m pip install -r worker\requirements.txt
```

If Python reports `ModuleNotFoundError: No module named 'OCP'` after installation,
remove the unrelated package that uses the conflicting `ocp` package name and
reinstall the worker dependencies:

```powershell
python -m pip uninstall -y ocp-windows-amd64
python -m pip install --force-reinstall -r worker\requirements.txt
```

## Supported modeling features

The worker accepts a JSON feature tree and supports:

- Rigid transforms with `transform` (`translation` and Euler `rotation` in degrees)
- `revolve` and `sweep` operations
- `fillet` and `chamfer`, with `edge_indices` or directional `edge_selector`
- `hole` and `counterbore` operations
- `mirror` and linear or polar `pattern` operations
- Multiple bodies using a node-level `body` identifier; separate bodies are
  returned together as a compound

Examples of the main feature parameters:

```json
{"type": "transform", "params": {
  "target": "part", "translation": [10, 0, 0], "rotation": [0, 0, 45]
}}
{"type": "revolve", "params": {
  "profile": "profile", "axis": "Z", "angle": 360
}}
{"type": "sweep", "params": {
  "section": "section", "path": "path"
}}
{"type": "chamfer", "params": {
  "target": "part", "length": 1, "edge_selector": "vertical"
}}
{"type": "hole", "params": {
  "target": "part", "location": [0, 0, 5], "radius": 2
}}
{"type": "counterbore", "params": {
  "target": "part", "location": [0, 0, 5], "radius": 2,
  "counterbore_radius": 4, "counterbore_depth": 2
}}
{"type": "pattern", "params": {
  "target": "part", "pattern": "polar", "pattern_radius": 20, "count": 6
}}
```

Paths for sweeps use a separate `path` feature with `line` or `spline`
entities. `edge_selector` accepts `all`, `X`, `Y`, `Z`, `horizontal`, and
`vertical`; explicit zero-based edge indexes are also supported.

## Web UI development

The web application uses a Go API and a React/Vite/Three.js client.

Install the frontend dependencies:

```powershell
Set-Location web
npm install
```

Start the Go API from the repository root:

```powershell
go run .\cmd\server
```

In a second terminal, start the Vite development server:

```powershell
Set-Location web
npm run dev
```

Open `http://localhost:5173`. The client sends feature trees to
`POST /api/compile`; the Go server runs `worker\builder.py` and returns the
generated mesh for the Three.js viewport.

For a standalone Go-served build:

```powershell
Set-Location web
npm run build
Set-Location ..
go run .\cmd\server
```

Then open `http://localhost:8080`.
