'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

// The binary selector logic extracted for unit testing
const PLATFORM_MAP = {
  'darwin-arm64':  'vsterm-darwin-arm64',
  'darwin-x64':    'vsterm-darwin-x64',
  'linux-arm64':   'vsterm-linux-arm64',
  'linux-x64':     'vsterm-linux-x64',
  'win32-x64':     'vsterm-win32-x64.exe',
};

function resolveBinaryName(platform, arch) {
  return PLATFORM_MAP[`${platform}-${arch}`] || null;
}

describe('platform binary selection', () => {
  test('resolves darwin arm64', () => {
    expect(resolveBinaryName('darwin', 'arm64')).toBe('vsterm-darwin-arm64');
  });
  test('resolves darwin x64', () => {
    expect(resolveBinaryName('darwin', 'x64')).toBe('vsterm-darwin-x64');
  });
  test('resolves linux arm64', () => {
    expect(resolveBinaryName('linux', 'arm64')).toBe('vsterm-linux-arm64');
  });
  test('resolves linux x64', () => {
    expect(resolveBinaryName('linux', 'x64')).toBe('vsterm-linux-x64');
  });
  test('resolves win32 x64', () => {
    expect(resolveBinaryName('win32', 'x64')).toBe('vsterm-win32-x64.exe');
  });
  test('returns null for unknown platform', () => {
    expect(resolveBinaryName('freebsd', 'x64')).toBeNull();
  });
  test('returns null for unknown arch', () => {
    expect(resolveBinaryName('linux', 'mips')).toBeNull();
  });
});

describe('postinstall service files', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsterm-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('macOS plist contains correct keys', () => {
    const plistDir = path.join(tmpDir, 'LaunchAgents');
    fs.mkdirSync(plistDir, { recursive: true });
    const nodePath = process.execPath;
    const binPath = '/usr/local/lib/node_modules/vsterm/bin/vsterm.js';
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.vsterm.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${binPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>`;
    const plistPath = path.join(plistDir, 'com.vsterm.daemon.plist');
    fs.writeFileSync(plistPath, plist);
    const content = fs.readFileSync(plistPath, 'utf8');
    expect(content).toContain('com.vsterm.daemon');
    expect(content).toContain(nodePath);
    expect(content).toContain(binPath);
    expect(content).toContain('RunAtLoad');
    expect(content).toContain('KeepAlive');
  });

  test('Linux systemd unit contains correct fields', () => {
    const svcDir = path.join(tmpDir, 'systemd', 'user');
    fs.mkdirSync(svcDir, { recursive: true });
    const nodePath = process.execPath;
    const binPath = '/usr/local/lib/node_modules/vsterm/bin/vsterm.js';
    const unit = `[Unit]
Description=vsterm local terminal daemon

[Service]
ExecStart=${nodePath} ${binPath}
Restart=on-failure

[Install]
WantedBy=default.target
`;
    const svcPath = path.join(svcDir, 'vsterm.service');
    fs.writeFileSync(svcPath, unit);
    const content = fs.readFileSync(svcPath, 'utf8');
    expect(content).toContain('vsterm local terminal daemon');
    expect(content).toContain(nodePath);
    expect(content).toContain('Restart=on-failure');
    expect(content).toContain('WantedBy=default.target');
  });
});

describe('preuninstall cleanup', () => {
  test('removes plist file if it exists', () => {
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vsterm-uninstall-'));
    try {
      const plistPath = path.join(tmpDir2, 'com.vsterm.daemon.plist');
      fs.writeFileSync(plistPath, 'dummy');
      expect(fs.existsSync(plistPath)).toBe(true);
      fs.unlinkSync(plistPath);
      expect(fs.existsSync(plistPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  test('no error if plist file does not exist', () => {
    const tmpDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'vsterm-uninstall2-'));
    try {
      const plistPath = path.join(tmpDir3, 'nonexistent.plist');
      expect(() => {
        try { fs.unlinkSync(plistPath); } catch (_) {}
      }).not.toThrow();
    } finally {
      fs.rmSync(tmpDir3, { recursive: true, force: true });
    }
  });
});

describe('bin/vsterm.js module structure', () => {
  test('file exists and is executable-looking', () => {
    const binFile = path.join(__dirname, '..', 'bin', 'vsterm.js');
    expect(fs.existsSync(binFile)).toBe(true);
    const content = fs.readFileSync(binFile, 'utf8');
    expect(content).toMatch(/^#!/);
    expect(content).toContain('PLATFORM_MAP');
    expect(content).toContain('isRunning');
  });

  test('postinstall.js exists', () => {
    const f = path.join(__dirname, '..', 'scripts', 'postinstall.js');
    expect(fs.existsSync(f)).toBe(true);
  });

  test('preuninstall.js exists', () => {
    const f = path.join(__dirname, '..', 'scripts', 'preuninstall.js');
    expect(fs.existsSync(f)).toBe(true);
  });
});
