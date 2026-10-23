package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

type compileRequest struct {
	Features json.RawMessage `json:"features"`
}

func main() {
	root, err := os.Getwd()
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", healthHandler)
	mux.HandleFunc("/api/compile", compileHandler(root))

	webDir := filepath.Join(root, "web", "dist")
	mux.Handle("/", http.FileServer(http.Dir(webDir)))

	server := &http.Server{
		Addr:              ":8080",
		Handler:           loggingMiddleware(mux),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      60 * time.Second,
	}
	log.Printf("Paralogic UI: http://localhost%s", server.Addr)
	log.Fatal(server.ListenAndServe())
}

func healthHandler(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
}

func compileHandler(root string) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		request.Body = http.MaxBytesReader(writer, request.Body, 2<<20)
		defer request.Body.Close()

		var payload compileRequest
		decoder := json.NewDecoder(request.Body)
		if err := decoder.Decode(&payload); err != nil {
			http.Error(writer, "invalid JSON request", http.StatusBadRequest)
			return
		}
		if len(payload.Features) == 0 || !json.Valid(payload.Features) {
			http.Error(writer, "features must be valid JSON", http.StatusBadRequest)
			return
		}

		result, err := runBuilder(root, payload.Features)
		if err != nil {
			log.Printf("builder failed: %v", err)
			writeJSON(writer, http.StatusUnprocessableEntity, result)
			return
		}
		writeJSON(writer, http.StatusOK, result)
	}
}

func runBuilder(root string, features json.RawMessage) (map[string]any, error) {
	builder := filepath.Join(root, "worker", "builder.py")
	command := exec.Command("python", builder)
	command.Dir = root
	command.Stdin = bytes.NewReader(features)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		if _, ok := err.(*exec.ExitError); ok {
			var failure map[string]any
			if json.Unmarshal(output, &failure) == nil {
				return failure, err
			}
			var stderrFailure map[string]any
			if json.Unmarshal(stderr.Bytes(), &stderrFailure) == nil {
				return stderrFailure, err
			}
			log.Printf("builder stderr: %s", stderr.String())
		}
		return map[string]any{
			"success": false,
			"error":   "could not execute the Python builder",
		}, err
	}

	var result map[string]any
	if err := json.Unmarshal(output, &result); err != nil {
		return map[string]any{
			"success": false,
			"error":   "builder returned invalid JSON",
		}, err
	}
	if success, ok := result["success"].(bool); !ok || !success {
		return result, errors.New("builder returned an unsuccessful result")
	}
	return result, nil
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
