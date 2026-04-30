package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
)

type Session struct {
	id   string
	ptmx *os.File
	cmd  *exec.Cmd
	done chan struct{}
}

type SessionManager struct {
	mu       sync.Mutex
	sessions map[string]*Session
}

func NewSessionManager() *SessionManager {
	return &SessionManager{sessions: make(map[string]*Session)}
}

type wsMsg struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Data string `json:"data,omitempty"`
	Cols uint16 `json:"cols,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
	Code int    `json:"code,omitempty"`
	Msg  string `json:"msg,omitempty"`
}

func encodeMsg(m wsMsg) []byte {
	b, _ := json.Marshal(m)
	return b
}

func (sm *SessionManager) Spawn(id string, cols, rows uint16, send chan<- []byte) error {
	sm.mu.Lock()
	if _, exists := sm.sessions[id]; exists {
		sm.mu.Unlock()
		return fmt.Errorf("session %s already exists", id)
	}
	ptmx, cmd, err := spawnPTY(cols, rows)
	if err != nil {
		sm.mu.Unlock()
		return err
	}
	done := make(chan struct{})
	s := &Session{id: id, ptmx: ptmx, cmd: cmd, done: done}
	sm.sessions[id] = s
	sm.mu.Unlock()

	go func() {
		defer func() { recover() }() // guard against send on closed channel
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				select {
				case <-done:
					return
				case send <- encodeMsg(wsMsg{
					Type: "output",
					ID:   id,
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
	return nil
}

func (sm *SessionManager) Input(id, data string) error {
	sm.mu.Lock()
	s, ok := sm.sessions[id]
	sm.mu.Unlock()
	if !ok {
		return fmt.Errorf("unknown session")
	}
	_, err := s.ptmx.Write([]byte(data))
	return err
}

func (sm *SessionManager) Resize(id string, cols, rows uint16) error {
	sm.mu.Lock()
	s, ok := sm.sessions[id]
	sm.mu.Unlock()
	if !ok {
		return fmt.Errorf("unknown session")
	}
	return resizePTY(s.ptmx, cols, rows)
}

func (sm *SessionManager) Kill(id string) error {
	sm.mu.Lock()
	s, ok := sm.sessions[id]
	if ok {
		delete(sm.sessions, id)
	}
	sm.mu.Unlock()
	if !ok {
		return fmt.Errorf("unknown session")
	}
	close(s.done)
	if s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	_ = s.ptmx.Close()
	return nil
}

func (sm *SessionManager) KillAll() {
	sm.mu.Lock()
	ids := make([]string, 0, len(sm.sessions))
	for id := range sm.sessions {
		ids = append(ids, id)
	}
	sm.mu.Unlock()
	for _, id := range ids {
		_ = sm.Kill(id)
	}
}

// WriteTo is used in tests to read raw PTY output without the session goroutine.
func (sm *SessionManager) WriteToPTY(id string, data []byte) error {
	sm.mu.Lock()
	s, ok := sm.sessions[id]
	sm.mu.Unlock()
	if !ok {
		return fmt.Errorf("unknown session")
	}
	_, err := s.ptmx.Write(data)
	return err
}

// PTYFile returns the PTY file for a session (used in tests).
func (sm *SessionManager) PTYFile(id string) (*os.File, error) {
	sm.mu.Lock()
	s, ok := sm.sessions[id]
	sm.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("unknown session")
	}
	return s.ptmx, nil
}

// ensure io is imported (used for test helpers elsewhere)
var _ = io.EOF
