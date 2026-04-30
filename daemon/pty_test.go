package main

import (
	"strings"
	"testing"
	"time"
)

func TestSpawnPTY(t *testing.T) {
	ptmx, cmd, err := spawnPTY(80, 24)
	if err != nil {
		t.Fatalf("spawnPTY error: %v", err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		_ = ptmx.Close()
		_ = cmd.Wait()
	}()

	if ptmx == nil {
		t.Fatal("expected non-nil ptmx")
	}
	if cmd == nil || cmd.Process == nil {
		t.Fatal("expected running process")
	}
}

func TestSpawnAndEcho(t *testing.T) {
	ptmx, cmd, err := spawnPTY(80, 24)
	if err != nil {
		t.Fatalf("spawnPTY: %v", err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		_ = ptmx.Close()
		_ = cmd.Wait()
	}()

	// write a command
	_, err = ptmx.Write([]byte("echo vsterm_test_ping\r"))
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	// read output with timeout
	result := make(chan string, 1)
	go func() {
		buf := make([]byte, 4096)
		total := ""
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			ptmx.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
			n, _ := ptmx.Read(buf)
			if n > 0 {
				total += string(buf[:n])
				if strings.Contains(total, "vsterm_test_ping") {
					result <- total
					return
				}
			}
		}
		result <- total
	}()

	out := <-result
	if !strings.Contains(out, "vsterm_test_ping") {
		t.Fatalf("expected echo output, got: %q", out)
	}
}

func TestResizePTY(t *testing.T) {
	ptmx, cmd, err := spawnPTY(80, 24)
	if err != nil {
		t.Fatalf("spawnPTY: %v", err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		_ = ptmx.Close()
		_ = cmd.Wait()
	}()

	if err := resizePTY(ptmx, 120, 40); err != nil {
		t.Fatalf("resizePTY: %v", err)
	}
}
