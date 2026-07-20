// ABOUTME: Build a portable zip from the Tauri release binary after packaging.
// ABOUTME: Reads productName/version from tauri.conf.json; Windows uses Compress-Archive.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STAGING_DIR_PREFIX = "langnext-portable-";
const HOST_ARCH_LABELS = {
  x86_64: "x64",
  aarch64: "arm64",
  i686: "x86",
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");

function readProductConfig() {
  const confPath = path.join(root, "src-tauri", "tauri.conf.json");
  const conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
  return {
    productName: conf.productName,
    version: conf.version,
  };
}

function resolveHostArch() {
  const rustcVv = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const hostMatch = rustcVv.match(/^host:\s*(.+)$/m);
  const hostTriple = hostMatch ? hostMatch[1].trim() : "";
  const cpu = hostTriple.split("-")[0] || "unknown";
  return HOST_ARCH_LABELS[cpu] ?? cpu;
}

function packagePortableZip() {
  const { productName, version } = readProductConfig();
  const arch = resolveHostArch();
  const isWindows = process.platform === "win32";
  const binaryName = isWindows ? `${productName}.exe` : productName;
  const releaseDir = path.join(root, "src-tauri", "target", "release");
  const binaryPath = path.join(releaseDir, binaryName);

  if (!fs.existsSync(binaryPath)) {
    console.error(`Portable zip skipped: binary not found at ${binaryPath}`);
    return null;
  }

  const portableDir = path.join(releaseDir, "bundle", "portable");
  fs.mkdirSync(portableDir, { recursive: true });

  const zipName = `${productName}_${version}_${arch}_portable.zip`;
  const zipPath = path.join(portableDir, zipName);
  fs.rmSync(zipPath, { force: true });

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), STAGING_DIR_PREFIX));
  try {
    fs.copyFileSync(binaryPath, path.join(stagingDir, binaryName));

    if (isWindows) {
      const psStaging = stagingDir.replaceAll("'", "''");
      const psZip = zipPath.replaceAll("'", "''");
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Compress-Archive -Path (Join-Path '${psStaging}' '*') -DestinationPath '${psZip}' -Force`,
        ],
        { stdio: "inherit" },
      );
    } else {
      execFileSync("zip", ["-q", "-9", "-j", zipPath, path.join(stagingDir, binaryName)], {
        stdio: "inherit",
      });
    }
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  console.log(`Portable zip: ${zipPath}`);
  return zipPath;
}

packagePortableZip();
