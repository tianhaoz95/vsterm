'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const binPath = path.resolve(__dirname, '..', 'bin', 'vsterm.js');

function installMac() {
  const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  fs.mkdirSync(plistDir, { recursive: true });
  const plistPath = path.join(plistDir, 'com.vsterm.daemon.plist');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.vsterm.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${binPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(os.homedir(), '.vsterm', 'daemon.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(os.homedir(), '.vsterm', 'daemon.log')}</string>
</dict>
</plist>`;
  fs.mkdirSync(path.join(os.homedir(), '.vsterm'), { recursive: true });
  fs.writeFileSync(plistPath, plist);
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null; launchctl load "${plistPath}"`, { stdio: 'ignore' });
  } catch (_) {}
}

function installLinux() {
  const svcDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  fs.mkdirSync(svcDir, { recursive: true });
  const svcPath = path.join(svcDir, 'vsterm.service');
  const unit = `[Unit]
Description=vsterm local terminal daemon

[Service]
ExecStart=${process.execPath} ${binPath}
Restart=on-failure

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(svcPath, unit);
  try {
    execSync('systemctl --user daemon-reload && systemctl --user enable --now vsterm', { stdio: 'ignore' });
  } catch (_) {}
}

function installWindows() {
  const taskName = 'vsterm-daemon';
  const cmd = `schtasks /create /tn "${taskName}" /tr "${process.execPath} ${binPath}" /sc onlogon /rl limited /f`;
  try {
    execSync(cmd, { stdio: 'ignore' });
    execSync(`schtasks /run /tn "${taskName}"`, { stdio: 'ignore' });
  } catch (_) {}
}

if (process.env.VSTERM_SKIP_SERVICE) {
  process.exit(0);
}

try {
  if (process.platform === 'darwin') {
    installMac();
  } else if (process.platform === 'linux') {
    installLinux();
  } else if (process.platform === 'win32') {
    installWindows();
  }
  console.log('vsterm daemon registered as a login service');
} catch (err) {
  // non-fatal: service registration is best-effort
  console.warn('vsterm: could not register login service:', err.message);
}
