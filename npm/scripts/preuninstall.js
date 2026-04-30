'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function uninstallMac() {
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.vsterm.daemon.plist');
  try { execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'ignore' }); } catch (_) {}
  try { fs.unlinkSync(plistPath); } catch (_) {}
}

function uninstallLinux() {
  try { execSync('systemctl --user disable --now vsterm 2>/dev/null', { stdio: 'ignore' }); } catch (_) {}
  const svcPath = path.join(os.homedir(), '.config', 'systemd', 'user', 'vsterm.service');
  try { fs.unlinkSync(svcPath); } catch (_) {}
  try { execSync('systemctl --user daemon-reload', { stdio: 'ignore' }); } catch (_) {}
}

function uninstallWindows() {
  try { execSync('schtasks /delete /tn "vsterm-daemon" /f', { stdio: 'ignore' }); } catch (_) {}
}

function stopDaemon() {
  try {
    if (process.platform === 'win32') {
      execSync('cmd /c "for /f \\"tokens=5\\" %a in (\'netstat -aon ^| findstr :7007\') do taskkill /F /PID %a"', { stdio: 'ignore' });
    } else {
      execSync('kill $(lsof -ti tcp:7007) 2>/dev/null || true', { shell: true, stdio: 'ignore' });
    }
  } catch (_) {}
}

if (process.env.VSTERM_SKIP_SERVICE) {
  process.exit(0);
}

try {
  stopDaemon();
  if (process.platform === 'darwin') {
    uninstallMac();
  } else if (process.platform === 'linux') {
    uninstallLinux();
  } else if (process.platform === 'win32') {
    uninstallWindows();
  }
  console.log('vsterm daemon service removed');
} catch (err) {
  console.warn('vsterm: could not fully remove service:', err.message);
}
