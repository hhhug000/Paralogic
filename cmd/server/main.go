package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

const maxRequestBytes = 2 << 20

type modelRequest struct {
	Features  json.RawMessage `json:"features"`
	Selection json.RawMessage `json:"selection,omitempty"`
}

type config struct {
	root    string
	python  string
	timeout time.Duration
	pool    *workerPool
}

func main() {
	addr := flag.String("addr", envOr("PARALOGIC_ADDR", "127.0.0.1:8080"), "listen address")
	root := flag.String("root", os.Getenv("PARALOGIC_ROOT"), "repository root (auto-detected when empty)")
	python := flag.String("python", os.Getenv("PARALOGIC_PYTHON"), "Python interpreter (auto-detected when empty)")
	timeout := flag.Duration("timeout", 60*time.Second, "maximum time for one model build")
	workers := flag.Int("workers", runtime.NumCPU(), "maximum number of concurrent model builds")
	flag.Parse()

	if *root == "" {
		detected, err := findRoot()
		if err != nil {
			log.Fatal(err)
		}
		*root = detected
	}
	if *python == "" {
		*python = findPython(*root)
	}
	if *workers < 1 {
		*workers = 1
	}
	cfg := newConfig(*root, *python, *timeout, *workers)
	// Start one worker straight away so the first build does not wait for
	// Python to import the CAD libraries.
	go cfg.pool.warm()
	go func() {
		signals := make(chan os.Signal, 1)
		signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
		<-signals
		cfg.pool.close()
		os.Exit(0)
	}()

	server := &http.Server{
		Addr:              *addr,
		Handler:           loggingMiddleware(newMux(cfg)),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      cfg.timeout + 30*time.Second,
	}
	log.Printf("root %s, python %s", cfg.root, cfg.python)
	log.Printf("Paralogic UI: http://%s", server.Addr)
	log.Fatal(server.ListenAndServe())
}

func newConfig(root, python string, timeout time.Duration, workers int) *config {
	return &config{
		root:    root,
		python:  python,
		timeout: timeout,
		pool:    newWorkerPool(python, filepath.Join(root, "worker", "builder.py"), root, workers),
	}
}

func newMux(cfg *config) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", healthHandler)
	mux.HandleFunc("/api/compile", cfg.compileHandler)
	mux.HandleFunc("/api/export/step", cfg.exportStepHandler)
	mux.HandleFunc("/api/measure", cfg.measureHandler)
	mux.Handle("/", http.FileServer(http.Dir(filepath.Join(cfg.root, "web", "dist"))))
	return mux
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

// findRoot walks up from the working directory and the executable's directory
// until it finds the worker, so the server can be started from anywhere inside
// the repository.
func findRoot() (string, error) {
	var starts []string
	if wd, err := os.Getwd(); err == nil {
		starts = append(starts, wd)
	}
	if exe, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(exe))
	}
	for _, start := range starts {
		for dir := start; ; dir = filepath.Dir(dir) {
			if _, err := os.Stat(filepath.Join(dir, "worker", "builder.py")); err == nil {
				return dir, nil
			}
			if filepath.Dir(dir) == dir {
				break
			}
		}
	}
	return "", errors.New("could not find worker/builder.py; pass -root or set PARALOGIC_ROOT")
}

// findPython prefers a project virtual environment, then python3, then python.
func findPython(root string) string {
	candidates := []string{
		filepath.Join(root, ".venv", "bin", "python"),
		filepath.Join(root, ".venv", "Scripts", "python.exe"),
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	for _, name := range []string{"python3", "python"} {
		if path, err := exec.LookPath(name); err == nil {
			return path
		}
	}
	return "python"
}

func healthHandler(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeError(writer, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
}

func readModelRequest(writer http.ResponseWriter, request *http.Request) (modelRequest, bool) {
	var payload modelRequest
	if request.Method != http.MethodPost {
		writeError(writer, http.StatusMethodNotAllowed, "method not allowed")
		return payload, false
	}
	request.Body = http.MaxBytesReader(writer, request.Body, maxRequestBytes)
	defer request.Body.Close()

	if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid JSON request")
		return payload, false
	}
	if len(payload.Features) == 0 || !json.Valid(payload.Features) {
		writeError(writer, http.StatusBadRequest, "features must be valid JSON")
		return payload, false
	}
	return payload, true
}

func (cfg *config) compileHandler(writer http.ResponseWriter, request *http.Request) {
	payload, ok := readModelRequest(writer, request)
	if !ok {
		return
	}
	output, status := cfg.run(request.Context(), map[string]any{"op": "compile", "features": payload.Features})
	writeRaw(writer, status, output)
}

func (cfg *config) measureHandler(writer http.ResponseWriter, request *http.Request) {
	payload, ok := readModelRequest(writer, request)
	if !ok {
		return
	}
	if len(payload.Selection) == 0 || !json.Valid(payload.Selection) {
		writeError(writer, http.StatusBadRequest, "selection must be valid JSON")
		return
	}
	output, status := cfg.run(request.Context(), map[string]any{
		"op":        "measure",
		"features":  payload.Features,
		"selection": payload.Selection,
	})
	writeRaw(writer, status, output)
}

func (cfg *config) exportStepHandler(writer http.ResponseWriter, request *http.Request) {
	payload, ok := readModelRequest(writer, request)
	if !ok {
		return
	}
	directory, err := os.MkdirTemp("", "paralogic-step-")
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "could not create export directory")
		return
	}
	defer os.RemoveAll(directory)

	stepPath := filepath.Join(directory, "model.step")
	output, status := cfg.run(request.Context(), map[string]any{
		"op":       "export_step",
		"features": payload.Features,
		"step":     stepPath,
	})
	if status != http.StatusOK {
		writeRaw(writer, status, output)
		return
	}
	step, err := os.ReadFile(stepPath)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "builder did not write a STEP file")
		return
	}
	writer.Header().Set("Content-Type", "application/step")
	writer.Header().Set("Content-Disposition", `attachment; filename="model.step"`)
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(step)
}

// run sends one request to a pooled worker and maps the reply to an HTTP
// status. The worker is killed when the timeout expires or the client leaves.
func (cfg *config) run(ctx context.Context, request map[string]any) ([]byte, int) {
	ctx, cancel := context.WithTimeout(ctx, cfg.timeout)
	defer cancel()

	output, err := cfg.pool.do(ctx, request)
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		log.Printf("builder timed out after %s", cfg.timeout)
		return errorBody(fmt.Sprintf("model build exceeded %s", cfg.timeout)), http.StatusGatewayTimeout
	case errors.Is(err, context.Canceled):
		return errorBody("request cancelled"), http.StatusServiceUnavailable
	case err != nil:
		log.Printf("builder failed: %v", err)
		return errorBody("could not execute the Python builder; see server log"), http.StatusInternalServerError
	}

	var result struct {
		Success *bool `json:"success"`
	}
	if json.Unmarshal(output, &result) != nil || result.Success == nil {
		log.Printf("builder returned an invalid reply: %.200s", output)
		return errorBody("builder returned an invalid reply"), http.StatusInternalServerError
	}
	if !*result.Success {
		return output, http.StatusUnprocessableEntity
	}
	return output, http.StatusOK
}

func errorBody(message string) []byte {
	body, _ := json.Marshal(map[string]any{"success": false, "error": message})
	return body
}

func writeRaw(writer http.ResponseWriter, status int, body []byte) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_, _ = writer.Write(body)
}

func writeError(writer http.ResponseWriter, status int, message string) {
	writeRaw(writer, status, errorBody(message))
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		start := time.Now()
		next.ServeHTTP(writer, request)
		log.Printf("%s %s (%s)", request.Method, request.URL.Path, time.Since(start))
	})
}
