package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
)

// workerProcess is one long-running `builder.py --serve` process. It answers
// one newline-delimited JSON request at a time.
type workerProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
	exited chan struct{}
}

func (worker *workerProcess) kill() {
	_ = worker.cmd.Process.Kill()
	<-worker.exited
}

// workerPool keeps up to max workers alive between requests, so Python and
// the CAD libraries are loaded once and each worker's feature cache stays
// warm. A worker that times out, crashes or replies out of turn is killed and
// replaced on demand.
type workerPool struct {
	python, script, dir string
	slots               chan struct{}
	idle                chan *workerProcess
	nextID              atomic.Int64
	mu                  sync.Mutex
	all                 map[*workerProcess]struct{}
	closed              bool
}

func newWorkerPool(python, script, dir string, max int) *workerPool {
	if max < 1 {
		max = 1
	}
	return &workerPool{
		python: python,
		script: script,
		dir:    dir,
		slots:  make(chan struct{}, max),
		idle:   make(chan *workerProcess, max),
		all:    make(map[*workerProcess]struct{}),
	}
}

func (pool *workerPool) spawn() (*workerProcess, error) {
	pool.mu.Lock()
	defer pool.mu.Unlock()
	if pool.closed {
		return nil, errors.New("worker pool is closed")
	}
	cmd := exec.Command(pool.python, pool.script, "--serve")
	cmd.Dir = pool.dir
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("starting %s: %w", pool.python, err)
	}
	worker := &workerProcess{
		cmd:    cmd,
		stdin:  stdin,
		stdout: bufio.NewReaderSize(stdout, 1<<20),
		exited: make(chan struct{}),
	}
	pool.all[worker] = struct{}{}
	go func() {
		_ = cmd.Wait()
		pool.mu.Lock()
		delete(pool.all, worker)
		pool.mu.Unlock()
		close(worker.exited)
	}()
	return worker, nil
}

// warm starts a worker ahead of the first request.
func (pool *workerPool) warm() {
	worker, err := pool.spawn()
	if err != nil {
		log.Printf("could not start builder worker: %v", err)
		return
	}
	select {
	case pool.idle <- worker:
	default:
		worker.kill()
	}
}

func (pool *workerPool) close() {
	pool.mu.Lock()
	pool.closed = true
	workers := make([]*workerProcess, 0, len(pool.all))
	for worker := range pool.all {
		workers = append(workers, worker)
	}
	pool.mu.Unlock()
	for _, worker := range workers {
		worker.kill()
	}
}

// do sends one request and returns the worker's JSON reply.
func (pool *workerPool) do(ctx context.Context, request map[string]any) ([]byte, error) {
	select {
	case pool.slots <- struct{}{}:
		defer func() { <-pool.slots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	var worker *workerProcess
	for worker == nil {
		select {
		case candidate := <-pool.idle:
			select {
			case <-candidate.exited:
				continue // died while idle
			default:
				worker = candidate
			}
		default:
			spawned, err := pool.spawn()
			if err != nil {
				return nil, err
			}
			worker = spawned
		}
	}

	id := pool.nextID.Add(1)
	request["id"] = id
	line, err := json.Marshal(request)
	if err != nil {
		pool.idle <- worker
		return nil, err
	}

	type reply struct {
		line []byte
		err  error
	}
	replies := make(chan reply, 1)
	go func() {
		if _, err := worker.stdin.Write(append(line, '\n')); err != nil {
			replies <- reply{err: fmt.Errorf("writing to worker: %w", err)}
			return
		}
		output, err := worker.stdout.ReadBytes('\n')
		replies <- reply{line: bytes.TrimSpace(output), err: err}
	}()

	select {
	case <-ctx.Done():
		worker.kill()
		return nil, ctx.Err()
	case result := <-replies:
		if result.err != nil {
			worker.kill()
			return nil, fmt.Errorf("worker exited: %w", result.err)
		}
		var header struct {
			ID int64 `json:"id"`
		}
		if json.Unmarshal(result.line, &header) != nil || header.ID != id {
			worker.kill()
			return nil, fmt.Errorf("worker replied out of turn: %.200s", result.line)
		}
		pool.idle <- worker
		return result.line, nil
	}
}
