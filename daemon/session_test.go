package main

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func collectOutput(send <-chan []byte, timeout time.Duration, until func(string) bool) string {
	deadline := time.After(timeout)
	total := ""
	for {
		select {
		case msg, ok := <-send:
			if !ok {
				return total
			}
			var m wsMsg
			if err := json.Unmarshal(msg, &m); err != nil {
				continue
			}
			if m.Type == "output" {
				decoded, _ := base64.StdEncoding.DecodeString(m.Data)
				total += string(decoded)
				if until != nil && until(total) {
					return total
				}
			}
		case <-deadline:
			return total
		}
	}
}

func TestSessionSpawnAndInput(t *testing.T) {
	sm := NewSessionManager()
	send := make(chan []byte, 256)

	if err := sm.Spawn("t1", 80, 24, send); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer sm.KillAll()

	// drain initial shell output (prompt etc.)
	time.Sleep(300 * time.Millisecond)
	drainChan(send)

	// send a command (raw, not base64)
	if err := sm.Input("t1", "echo ping_session\r"); err != nil {
		t.Fatalf("Input: %v", err)
	}

	out := collectOutput(send, 3*time.Second, func(s string) bool {
		return strings.Contains(s, "ping_session")
	})
	if !strings.Contains(out, "ping_session") {
		t.Fatalf("expected ping_session in output, got: %q", out)
	}
}

func TestSessionUnknownID(t *testing.T) {
	sm := NewSessionManager()

	if err := sm.Input("nonexistent", "hello"); err == nil {
		t.Fatal("expected error for unknown session Input")
	}
	if err := sm.Resize("nonexistent", 80, 24); err == nil {
		t.Fatal("expected error for unknown session Resize")
	}
	if err := sm.Kill("nonexistent"); err == nil {
		t.Fatal("expected error for unknown session Kill")
	}
}

func TestSessionKill(t *testing.T) {
	sm := NewSessionManager()
	send := make(chan []byte, 256)

	if err := sm.Spawn("t1", 80, 24, send); err != nil {
		t.Fatalf("Spawn: %v", err)
	}

	if err := sm.Kill("t1"); err != nil {
		t.Fatalf("Kill: %v", err)
	}

	// should be gone now
	if err := sm.Input("t1", "hello"); err == nil {
		t.Fatal("expected error after kill")
	}
}

func TestSessionResize(t *testing.T) {
	sm := NewSessionManager()
	send := make(chan []byte, 256)

	if err := sm.Spawn("t1", 80, 24, send); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer sm.KillAll()

	if err := sm.Resize("t1", 120, 40); err != nil {
		t.Fatalf("Resize: %v", err)
	}
}

func TestSessionKillSendsNoMoreOutput(t *testing.T) {
	// Tests that Kill stops PTY output delivery (not the exit message path,
	// which is triggered by natural process death — tested below).
	sm := NewSessionManager()
	send := make(chan []byte, 512)

	if err := sm.Spawn("t1", 80, 24, send); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	time.Sleep(200 * time.Millisecond)

	if err := sm.Kill("t1"); err != nil {
		t.Fatalf("Kill: %v", err)
	}

	// session should be gone
	if err := sm.Input("t1", "x"); err == nil {
		t.Fatal("expected error after kill")
	}
}

func TestSessionNaturalExit(t *testing.T) {
	// Spawn a process that exits on its own immediately; expect an exit message.
	// Use /bin/sh -c 'echo hi' which is non-interactive and exits cleanly.
	sm := &SessionManager{sessions: make(map[string]*Session)}
	send := make(chan []byte, 512)

	// Spawn /bin/sh directly (non-interactive, exits right away)
	ptmx, cmd, err := spawnPTYCmd("/bin/sh", []string{"-c", "echo natural_exit_test"}, 80, 24)
	if err != nil {
		t.Fatalf("spawnPTYCmd: %v", err)
	}

	id := "t1"
	done := make(chan struct{})
	s := &Session{id: id, ptmx: ptmx, cmd: cmd, done: done}
	sm.mu.Lock()
	sm.sessions[id] = s
	sm.mu.Unlock()

	go func() {
		defer func() { recover() }()
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				select {
				case <-done:
					return
				case send <- encodeMsg(wsMsg{
					Type: "output", ID: id,
					Data: base64.StdEncoding.EncodeToString(buf[:n]),
				}):
				}
			}
			if err != nil {
				code := 0
				if cmd.ProcessState != nil {
					code = cmd.ProcessState.ExitCode()
				}
				sm.mu.Lock()
				delete(sm.sessions, id)
				sm.mu.Unlock()
				select {
				case <-done:
				case send <- encodeMsg(wsMsg{Type: "exit", ID: id, Code: code}):
				}
				return
			}
		}
	}()

	deadline := time.After(5 * time.Second)
	for {
		select {
		case msg, ok := <-send:
			if !ok {
				t.Fatal("channel closed")
			}
			var m wsMsg
			if err := json.Unmarshal(msg, &m); err != nil {
				continue
			}
			if m.Type == "exit" && m.ID == "t1" {
				return // success
			}
		case <-deadline:
			t.Fatal("timed out waiting for exit message from short-lived process")
		}
	}
}

func TestSessionDuplicateSpawn(t *testing.T) {
	sm := NewSessionManager()
	send := make(chan []byte, 256)

	if err := sm.Spawn("t1", 80, 24, send); err != nil {
		t.Fatalf("first Spawn: %v", err)
	}
	defer sm.KillAll()

	if err := sm.Spawn("t1", 80, 24, send); err == nil {
		t.Fatal("expected error on duplicate spawn")
	}
}

func TestKillAll(t *testing.T) {
	sm := NewSessionManager()
	send := make(chan []byte, 256)

	for _, id := range []string{"t1", "t2", "t3"} {
		if err := sm.Spawn(id, 80, 24, send); err != nil {
			t.Fatalf("Spawn %s: %v", id, err)
		}
	}

	sm.KillAll()

	// all sessions should be gone
	for _, id := range []string{"t1", "t2", "t3"} {
		if err := sm.Input(id, "x"); err == nil {
			t.Fatalf("expected session %s to be gone after KillAll", id)
		}
	}
}

func drainChan(ch <-chan []byte) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}
