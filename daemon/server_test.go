package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func startTestServer(t *testing.T) (*httptest.Server, *SessionManager) {
	t.Helper()
	sm := NewSessionManager()
	srv := httptest.NewServer(newMux(sm))
	t.Cleanup(func() {
		sm.KillAll()
		srv.Close()
	})
	return srv, sm
}

func wsURL(srv *httptest.Server) string {
	return "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
}

func dialWS(t *testing.T, srv *httptest.Server) *websocket.Conn {
	t.Helper()
	dialer := websocket.Dialer{}
	conn, _, err := dialer.Dial(wsURL(srv), nil)
	if err != nil {
		t.Fatalf("dial ws: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func sendJSON(t *testing.T, conn *websocket.Conn, msg wsMsg) {
	t.Helper()
	b, _ := json.Marshal(msg)
	if err := conn.WriteMessage(websocket.TextMessage, b); err != nil {
		t.Fatalf("write ws: %v", err)
	}
}

// readUntil collects messages from conn until the predicate returns true or timeout.
// It resets the read deadline on each iteration to avoid gorilla's "repeated read on failed connection" panic.
func readUntil(t *testing.T, conn *websocket.Conn, timeout time.Duration, pred func(wsMsg) bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return false
		}
		conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
		_, raw, err := conn.ReadMessage()
		conn.SetReadDeadline(time.Time{}) // reset after each read
		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				return false
			}
			// timeout — keep looping
			continue
		}
		var m wsMsg
		if err := json.Unmarshal(raw, &m); err != nil {
			continue
		}
		if pred(m) {
			return true
		}
	}
	return false
}

func readMsg(t *testing.T, conn *websocket.Conn, timeout time.Duration) (wsMsg, bool) {
	t.Helper()
	var m wsMsg
	found := readUntil(t, conn, timeout, func(msg wsMsg) bool {
		m = msg
		return true
	})
	return m, found
}

func TestStatusEndpoint(t *testing.T) {
	srv, _ := startTestServer(t)
	resp, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatalf("GET /: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
}

func TestCORSHeader(t *testing.T) {
	srv, _ := startTestServer(t)

	// allowed origins are echoed back
	for _, origin := range []string{
		"https://vscode.dev",
		"https://insiders.vscode.dev",
		"https://v--abc123.vscode-cdn.net",
		"http://localhost:5000",
	} {
		req, _ := http.NewRequest("GET", srv.URL+"/", nil)
		req.Header.Set("Origin", origin)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET / with origin %q: %v", origin, err)
		}
		resp.Body.Close()
		got := resp.Header.Get("Access-Control-Allow-Origin")
		if got != origin {
			t.Fatalf("origin %q: expected CORS header %q, got %q", origin, origin, got)
		}
	}

	// requests with no origin get no CORS header
	resp, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatalf("GET /: %v", err)
	}
	resp.Body.Close()
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("no-origin request: expected empty CORS header, got %q", got)
	}
}

func TestWebSocketConnect(t *testing.T) {
	srv, _ := startTestServer(t)
	conn := dialWS(t, srv)
	_ = conn
}

func TestSpawnAndEchoViaWS(t *testing.T) {
	srv, _ := startTestServer(t)
	conn := dialWS(t, srv)

	sendJSON(t, conn, wsMsg{Type: "spawn", ID: "t1", Cols: 80, Rows: 24})
	// wait for shell to settle
	time.Sleep(300 * time.Millisecond)

	sendJSON(t, conn, wsMsg{Type: "input", ID: "t1", Data: "echo ws_test_echo\r"})

	accumulated := ""
	found := readUntil(t, conn, 4*time.Second, func(m wsMsg) bool {
		if m.Type == "output" {
			decoded, _ := base64.StdEncoding.DecodeString(m.Data)
			accumulated += string(decoded)
			return strings.Contains(accumulated, "ws_test_echo")
		}
		return false
	})
	if !found {
		t.Fatalf("expected ws_test_echo in output, accumulated: %q", accumulated)
	}
}

func TestKillViaWS(t *testing.T) {
	srv, _ := startTestServer(t)
	conn := dialWS(t, srv)

	sendJSON(t, conn, wsMsg{Type: "spawn", ID: "t1", Cols: 80, Rows: 24})
	time.Sleep(200 * time.Millisecond)

	sendJSON(t, conn, wsMsg{Type: "kill", ID: "t1"})
	time.Sleep(100 * time.Millisecond)

	// subsequent input should produce an error response
	sendJSON(t, conn, wsMsg{Type: "input", ID: "t1", Data: "hello"})

	m, found := readMsg(t, conn, 2*time.Second)
	if !found {
		t.Fatal("expected response after kill+input")
	}
	if m.Type != "error" || m.ID != "t1" {
		// may have received exit message first; look for error
		found = readUntil(t, conn, 1*time.Second, func(msg wsMsg) bool {
			return msg.Type == "error" && msg.ID == "t1"
		})
		if !found {
			t.Fatalf("expected error msg for killed session, last msg: %+v", m)
		}
	}
}

func TestUnknownSessionError(t *testing.T) {
	srv, _ := startTestServer(t)
	conn := dialWS(t, srv)

	sendJSON(t, conn, wsMsg{Type: "input", ID: "nonexistent", Data: "hello"})

	found := readUntil(t, conn, 2*time.Second, func(m wsMsg) bool {
		return m.Type == "error" && m.ID == "nonexistent"
	})
	if !found {
		t.Fatal("expected error msg for unknown session")
	}
}

func TestMultipleConnections(t *testing.T) {
	srv, _ := startTestServer(t)
	conn1 := dialWS(t, srv)
	conn2 := dialWS(t, srv)

	sendJSON(t, conn1, wsMsg{Type: "spawn", ID: "t1", Cols: 80, Rows: 24})
	sendJSON(t, conn2, wsMsg{Type: "spawn", ID: "t1", Cols: 80, Rows: 24})
	time.Sleep(300 * time.Millisecond)

	// kill t1 on conn1
	sendJSON(t, conn1, wsMsg{Type: "kill", ID: "t1"})
	time.Sleep(100 * time.Millisecond)

	// conn2's t1 should still be alive
	sendJSON(t, conn2, wsMsg{Type: "input", ID: "t1", Data: "echo still_alive\r"})

	accumulated := ""
	found := readUntil(t, conn2, 4*time.Second, func(m wsMsg) bool {
		if m.Type == "output" {
			decoded, _ := base64.StdEncoding.DecodeString(m.Data)
			accumulated += string(decoded)
			return strings.Contains(accumulated, "still_alive")
		}
		return false
	})
	if !found {
		t.Fatalf("conn2 session affected by conn1 kill; accumulated: %q", accumulated)
	}
}

func TestResizeViaWS(t *testing.T) {
	srv, _ := startTestServer(t)
	conn := dialWS(t, srv)

	sendJSON(t, conn, wsMsg{Type: "spawn", ID: "t1", Cols: 80, Rows: 24})
	time.Sleep(200 * time.Millisecond)

	// valid resize — no error expected
	sendJSON(t, conn, wsMsg{Type: "resize", ID: "t1", Cols: 120, Rows: 40})
	time.Sleep(50 * time.Millisecond)

	// unknown resize — expect error
	sendJSON(t, conn, wsMsg{Type: "resize", ID: "nope", Cols: 120, Rows: 40})

	found := readUntil(t, conn, 2*time.Second, func(m wsMsg) bool {
		return m.Type == "error" && m.ID == "nope"
	})
	if !found {
		t.Fatal("expected error for unknown session resize")
	}
}

func TestDefaultColsRows(t *testing.T) {
	srv, _ := startTestServer(t)
	conn := dialWS(t, srv)

	// spawn with zero cols/rows — server should default to 80x24
	sendJSON(t, conn, wsMsg{Type: "spawn", ID: "t1"})
	time.Sleep(200 * time.Millisecond)

	// shell should be alive — echo works
	sendJSON(t, conn, wsMsg{Type: "input", ID: "t1", Data: "echo default_size\r"})

	accumulated := ""
	found := readUntil(t, conn, 4*time.Second, func(m wsMsg) bool {
		if m.Type == "output" {
			decoded, _ := base64.StdEncoding.DecodeString(m.Data)
			accumulated += string(decoded)
			return strings.Contains(accumulated, "default_size")
		}
		return false
	})
	if !found {
		t.Fatalf("expected default_size echo; got: %q", accumulated)
	}
}
