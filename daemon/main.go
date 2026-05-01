package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET")
		next.ServeHTTP(w, r)
	})
}

func handleWS(sm *SessionManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("upgrade error: %v", err)
			return
		}
		defer conn.Close()

		send := make(chan []byte, 256)
		connSM := NewSessionManager()

		// writer goroutine
		go func() {
			for msg := range send {
				if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
					return
				}
			}
		}()

		defer func() {
			connSM.KillAll()
			close(send)
		}()

		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var msg wsMsg
			if err := json.Unmarshal(raw, &msg); err != nil {
				continue
			}
			switch msg.Type {
			case "spawn":
				cols, rows := msg.Cols, msg.Rows
				if cols == 0 {
					cols = 80
				}
				if rows == 0 {
					rows = 24
				}
				if err := connSM.Spawn(msg.ID, cols, rows, send); err != nil {
					send <- encodeMsg(wsMsg{Type: "error", ID: msg.ID, Msg: err.Error()})
				}
			case "input":
				if err := connSM.Input(msg.ID, msg.Data); err != nil {
					send <- encodeMsg(wsMsg{Type: "error", ID: msg.ID, Msg: "unknown session"})
				}
			case "resize":
				if err := connSM.Resize(msg.ID, msg.Cols, msg.Rows); err != nil {
					send <- encodeMsg(wsMsg{Type: "error", ID: msg.ID, Msg: "unknown session"})
				}
			case "kill":
				if err := connSM.Kill(msg.ID); err != nil {
					send <- encodeMsg(wsMsg{Type: "error", ID: msg.ID, Msg: "unknown session"})
				}
			}
		}
	}
}

func newMux(sm *SessionManager) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintln(w, "vsterm running")
	})
	mux.HandleFunc("/ws", handleWS(sm))
	return corsMiddleware(mux)
}

func main() {
	sm := NewSessionManager()
	addr := "127.0.0.1:7007"
	fmt.Printf("vsterm started on %s\n", addr)
	if err := http.ListenAndServe(addr, newMux(sm)); err != nil {
		log.Fatal(err)
	}
}
