.PHONY: all build build-all test test-daemon test-npm test-extension clean

BINARY_DIR := npm/binaries
DAEMON_SRC := ./daemon

all: build-all

build:
	cd daemon && go build -o ../$(BINARY_DIR)/vsterm-$$(go env GOOS)-$$(go env GOARCH) .

build-all:
	cd daemon && \
	GOOS=darwin  GOARCH=arm64 go build -o ../$(BINARY_DIR)/vsterm-darwin-arm64  . && \
	GOOS=darwin  GOARCH=amd64 go build -o ../$(BINARY_DIR)/vsterm-darwin-x64    . && \
	GOOS=linux   GOARCH=arm64 go build -o ../$(BINARY_DIR)/vsterm-linux-arm64   . && \
	GOOS=linux   GOARCH=amd64 go build -o ../$(BINARY_DIR)/vsterm-linux-x64     . && \
	GOOS=windows GOARCH=amd64 go build -o ../$(BINARY_DIR)/vsterm-win32-x64.exe .
	@echo "All binaries built:"
	@ls -lh $(BINARY_DIR)/

test: test-daemon test-npm test-extension

test-daemon:
	@echo "==> Running Go daemon tests"
	cd daemon && $(shell which go || echo /opt/homebrew/bin/go) test -v -timeout 30s ./...

test-npm:
	@echo "==> Running npm package tests"
	cd npm && npm test

test-extension:
	@echo "==> Running extension tests"
	cd extension && npm test

clean:
	rm -f $(BINARY_DIR)/vsterm-*
	rm -rf extension/dist extension/out
