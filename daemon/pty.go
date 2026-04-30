package main

import (
	"os"
	"os/exec"

	"github.com/creack/pty"
)

func spawnPTY(cols, rows uint16) (*os.File, *exec.Cmd, error) {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	cmd := exec.Command(shell)
	// Skip zsh first-run wizard and heavy startup scripts in automated/test contexts
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"ZDOTDIR=/dev/null", // point zsh at empty dotdir so no .zshrc/.zshenv
	)
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, nil, err
	}
	return ptmx, cmd, nil
}

func resizePTY(ptmx *os.File, cols, rows uint16) error {
	return pty.Setsize(ptmx, &pty.Winsize{Cols: cols, Rows: rows})
}

// spawnPTYCmd spawns an arbitrary command in a PTY (used in tests).
func spawnPTYCmd(name string, args []string, cols, rows uint16) (*os.File, *exec.Cmd, error) {
	cmd := exec.Command(name, args...)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, nil, err
	}
	return ptmx, cmd, nil
}
