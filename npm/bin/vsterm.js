#!/usr/bin/env node
'use strict';

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PLATFORM_MAP = {
  'darwin-arm64':  'vsterm-darwin-arm64',
  'darwin-x64':    'vsterm-darwin-x64',
  'linux-arm64':   'vsterm-linux-arm64',
  'linux-x64':     'vsterm-linux-x64',
  'win32-x64':     'vsterm-win32-x64.exe',
};

function binaryPath() {
  const key = `${process.platform}-${process.arch}`;
  const name = PLATFORM_MAP[key];
  if (!name) {
    console.error(`vsterm: unsupported platform: ${key}`);
    console.error(`Supported: ${Object.keys(PLATFORM_MAP).join(', ')}`);
    process.exit(1);
  }
  const p = path.join(__dirname, '..', 'binaries', name);
  if (!fs.existsSync(p)) {
    console.error(`vsterm: binary not found at ${p}`);
    console.error('Run "make build-all" to build the binaries.');
    process.exit(1);
  }
  return p;
}

function isRunning(cb) {
  const req = http.get('http://127.0.0.1:7007/', (res) => {
    cb(res.statusCode === 200);
  });
  req.on('error', () => cb(false));
  req.setTimeout(500, () => { req.destroy(); cb(false); });
}

const cmd = process.argv[2];

if (cmd === 'status') {
  isRunning((running) => {
    console.log(running ? 'running' : 'not running');
    process.exit(running ? 0 : 1);
  });
} else if (cmd === 'stop') {
  // send SIGTERM to any process listening on 7007 (best-effort)
  try {
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'for /f "tokens=5" %a in (\'netstat -aon ^| findstr :7007\') do taskkill /F /PID %a'], { stdio: 'ignore' });
    } else {
      execFileSync('sh', ['-c', "kill $(lsof -ti tcp:7007) 2>/dev/null || true"], { stdio: 'ignore' });
    }
    console.log('vsterm stopped');
  } catch (_) {
    console.log('vsterm: no running daemon found');
  }
} else {
  // default: start foreground (cmd === undefined or 'start')
  const bin = binaryPath();
  // ensure executable bit on unix
  if (process.platform !== 'win32') {
    try { fs.chmodSync(bin, 0o755); } catch (_) {}
  }
  const child = spawn(bin, [], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code || 0));
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}
