#!/usr/bin/env node
// Packages the extension with a relaxed engine requirement for older VS Code /
// code-server versions (e.g. code-server v4.16.1 / VS Code 1.80.2).
// Restores package.json unconditionally, even on failure.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PKG_PATH = path.join(__dirname, "..", "package.json");
const LEGACY_ENGINE = "^1.80.0";
const OUT_FILE = "nano-vsterm-legacy.vsix";

const original = fs.readFileSync(PKG_PATH, "utf8");
const pkg = JSON.parse(original);

pkg.engines = { vscode: LEGACY_ENGINE };
pkg.devDependencies["@types/vscode"] = LEGACY_ENGINE;

fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");

try {
  execSync(
    `npx @vscode/vsce package --no-dependencies -o ${OUT_FILE}`,
    { stdio: "inherit", cwd: path.join(__dirname, "..") }
  );
  console.log(`\nBuilt: extension/${OUT_FILE}`);
} finally {
  fs.writeFileSync(PKG_PATH, original);
}
