package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeWorker writes a stand-in worker/builder.py so handler behaviour can be
// tested without the CAD dependencies. handle is the body of a Python
// function that receives the request dict and returns a reply dict.
func fakeWorker(t *testing.T, handle string, timeout time.Duration) *config {
	t.Helper()
	python, err := exec.LookPath("python3")
	if err != nil {
		if python, err = exec.LookPath("python"); err != nil {
			t.Skip("python is not installed")
		}
	}
	script := `
import json, os, sys, time

def handle(request):
` + handle + `

for line in sys.stdin:
    request = json.loads(line)
    reply = handle(request)
    reply["id"] = request["id"]
    sys.stdout.write(json.dumps(reply) + "\n")
    sys.stdout.flush()
`
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "worker"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "worker", "builder.py"), []byte(script), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := newConfig(root, python, timeout, 1)
	t.Cleanup(cfg.pool.close)
	return cfg
}

func post(t *testing.T, cfg *config, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	newMux(cfg).ServeHTTP(recorder, request)
	return recorder
}

func decode(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON: %q", recorder.Body.String())
	}
	return body
}

const echoWorker = `
    return {"success": True, "op": request["op"], "count": len(request["features"]), "pid": os.getpid()}`

func TestCompilePassesWorkerReplyThrough(t *testing.T) {
	cfg := fakeWorker(t, echoWorker, 10*time.Second)
	recorder := post(t, cfg, "/api/compile", `{"features":[1,2,3]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status %d: %s", recorder.Code, recorder.Body.String())
	}
	body := decode(t, recorder)
	if body["op"] != "compile" || body["count"] != float64(3) {
		t.Fatalf("unexpected body %v", body)
	}
}

func TestWorkerIsReused(t *testing.T) {
	cfg := fakeWorker(t, echoWorker, 10*time.Second)
	first := decode(t, post(t, cfg, "/api/compile", `{"features":[]}`))
	second := decode(t, post(t, cfg, "/api/compile", `{"features":[]}`))
	if first["pid"] != second["pid"] {
		t.Fatalf("worker was not reused: %v then %v", first["pid"], second["pid"])
	}
}

func TestCompileRejectsBadRequests(t *testing.T) {
	cfg := fakeWorker(t, echoWorker, 10*time.Second)
	if code := post(t, cfg, "/api/compile", `{`).Code; code != http.StatusBadRequest {
		t.Fatalf("invalid JSON gave %d", code)
	}
	if code := post(t, cfg, "/api/compile", `{}`).Code; code != http.StatusBadRequest {
		t.Fatalf("missing features gave %d", code)
	}
	if code := post(t, cfg, "/api/measure", `{"features":[]}`).Code; code != http.StatusBadRequest {
		t.Fatalf("missing selection gave %d", code)
	}
	recorder := httptest.NewRecorder()
	newMux(cfg).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/compile", nil))
	if recorder.Code != http.StatusMethodNotAllowed || decode(t, recorder)["success"] != false {
		t.Fatalf("GET gave %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestMeasureForwardsSelection(t *testing.T) {
	cfg := fakeWorker(t, `
    return {"success": True, "op": request["op"], "selection": request["selection"]}`, 10*time.Second)
	body := decode(t, post(t, cfg, "/api/measure", `{"features":[],"selection":[{"kind":"edge","id":4}]}`))
	if body["op"] != "measure" || body["selection"].([]any)[0].(map[string]any)["id"] != float64(4) {
		t.Fatalf("unexpected body %v", body)
	}
}

func TestBuilderFailureIs422(t *testing.T) {
	cfg := fakeWorker(t, `
    return {"success": False, "error": "bad feature"}`, 10*time.Second)
	recorder := post(t, cfg, "/api/compile", `{"features":[]}`)
	if recorder.Code != http.StatusUnprocessableEntity || decode(t, recorder)["error"] != "bad feature" {
		t.Fatalf("status %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestCrashedWorkerIsReplaced(t *testing.T) {
	cfg := fakeWorker(t, `
    if request["features"] == ["crash"]:
        os._exit(3)
    return {"success": True, "pid": os.getpid()}`, 10*time.Second)
	before := decode(t, post(t, cfg, "/api/compile", `{"features":[]}`))
	recorder := post(t, cfg, "/api/compile", `{"features":["crash"]}`)
	if recorder.Code != http.StatusInternalServerError || decode(t, recorder)["success"] != false {
		t.Fatalf("crash gave %d: %s", recorder.Code, recorder.Body.String())
	}
	after := decode(t, post(t, cfg, "/api/compile", `{"features":[]}`))
	if after["success"] != true || after["pid"] == before["pid"] {
		t.Fatalf("worker was not replaced: %v then %v", before, after)
	}
}

func TestTimeoutKillsAndReplacesWorker(t *testing.T) {
	cfg := fakeWorker(t, `
    if request["features"] == ["slow"]:
        time.sleep(30)
    return {"success": True}`, 300*time.Millisecond)
	start := time.Now()
	recorder := post(t, cfg, "/api/compile", `{"features":["slow"]}`)
	if recorder.Code != http.StatusGatewayTimeout {
		t.Fatalf("status %d: %s", recorder.Code, recorder.Body.String())
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("worker was not killed promptly (%s)", elapsed)
	}
	// The next request must not be answered by the stuck worker.
	if code := post(t, cfg, "/api/compile", `{"features":[]}`).Code; code != http.StatusOK {
		t.Fatalf("request after timeout gave %d", code)
	}
}

func TestExportStepStreamsAndCleansUp(t *testing.T) {
	cfg := fakeWorker(t, `
    open(request["step"], "w").write("ISO-10303-21;")
    return {"success": True}`, 10*time.Second)
	recorder := post(t, cfg, "/api/export/step", `{"features":[]}`)
	if recorder.Code != http.StatusOK || recorder.Body.String() != "ISO-10303-21;" {
		t.Fatalf("status %d: %q", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Header().Get("Content-Disposition"), "model.step") {
		t.Fatalf("missing attachment header")
	}
	matches, _ := filepath.Glob(filepath.Join(os.TempDir(), "paralogic-step-*", "model.step"))
	if len(matches) > 0 {
		t.Fatalf("export file was left behind: %v", matches)
	}
}
