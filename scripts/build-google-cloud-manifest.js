// ABOUTME: Validates and updates the signed file index for the Google Cloud staging tree.
// ABOUTME: Keeps manifest payload paths, roles, bytes, and SHA-256 digests closed and deterministic.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const [stagingRoot, pluginDir, updateFlag, publicKeyHex] = process.argv.slice(2);
if (!stagingRoot || !pluginDir || !publicKeyHex) {
  throw new Error("usage: build-google-cloud-manifest.js <staging> <plugin-dir> <update:0|1> <public-key-hex>");
}
const update = updateFlag === "1";
const publicKey = Buffer.from(publicKeyHex, "hex");
if (publicKey.length !== 32) {
  throw new Error("vendor public key must be 32 bytes");
}

const manifestPath = path.join(pluginDir, "plugin.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const expected = new Map([
  ["translate/fixtures/langnext-google-cloud-translate.wasm", "runtime-artifact"],
  ["detect/fixtures/langnext-google-cloud-detect.wasm", "runtime-artifact"],
  ["ocr/fixtures/langnext-google-cloud-ocr.wasm", "runtime-artifact"],
  ["tts/fixtures/langnext-google-cloud-tts.wasm", "runtime-artifact"],
  ["schemas/config.json", "config-schema"],
  ["schemas/translate-preferences.json", "preference-schema"],
  ["schemas/ocr-preferences.json", "preference-schema"],
  ["schemas/speech-preferences.json", "preference-schema"],
  ["locales/en.json", "locale"],
  ["locales/zh-CN.json", "locale"],
]);

if (
  manifest.id !== "com.langnext.google-cloud" ||
  manifest.version !== "1.2.0" ||
  manifest.runtime?.kind !== "wasm-component" ||
  manifest.configSchemaVersion !== 1
) {
  throw new Error("Google Cloud manifest identity/schema mismatch");
}
if (manifest.publisher?.keyId !== "com.langnext.vendor.keys.1") {
  throw new Error("unexpected publisher key id");
}
const fingerprint = crypto.createHash("sha256").update(publicKey).digest("hex");
if (manifest.publisher.keyFingerprint !== fingerprint) {
  throw new Error("manifest publisher fingerprint does not match trust root");
}
const entries = new Map((manifest.files ?? []).map((entry) => [entry.path, entry]));
if (entries.size !== expected.size || manifest.files.length !== expected.size) {
  throw new Error("signed file index must contain exactly the required payload files");
}
for (const [relativePath, expectedRole] of expected) {
  const entry = entries.get(relativePath);
  if (!entry || entry.role !== expectedRole) {
    throw new Error(`manifest role/path mismatch for ${relativePath}`);
  }
  const bytes = fs.readFileSync(path.join(stagingRoot, relativePath));
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (!update && (entry.bytes !== bytes.length || entry.sha256 !== sha256)) {
    throw new Error(`digest drift for ${relativePath}`);
  }
  entry.bytes = bytes.length;
  entry.sha256 = sha256;
}
const expectedCapabilities = new Map([
  ["translate.text@1", "translate/fixtures/langnext-google-cloud-translate.wasm"],
  ["translate.detect@1", "detect/fixtures/langnext-google-cloud-detect.wasm"],
  ["ocr.image@1", "ocr/fixtures/langnext-google-cloud-ocr.wasm"],
  ["speech.synthesize@1", "tts/fixtures/langnext-google-cloud-tts.wasm"],
]);
if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length !== expectedCapabilities.size) {
  throw new Error("Google Cloud manifest must declare exactly four capabilities");
}
for (const capability of manifest.capabilities) {
  if (
    !expectedCapabilities.has(capability.id) ||
    capability.artifact !== expectedCapabilities.get(capability.id) ||
    typeof capability.preferencesSchema !== "string"
  ) {
    throw new Error(`unexpected Google Cloud capability declaration: ${capability.id}`);
  }
}
const expectedEndpoints = new Set(["translate", "vision", "text-to-speech"]);
const endpoints = new Set((manifest.permissions?.network ?? []).map((endpoint) => endpoint.id));
if (endpoints.size !== expectedEndpoints.size || [...expectedEndpoints].some((id) => !endpoints.has(id))) {
  throw new Error("Google Cloud manifest must declare exactly three fixed API endpoints");
}
if (
  !Array.isArray(manifest.permissions?.authPolicies) ||
  manifest.permissions.authPolicies.length !== 1 ||
  manifest.permissions.authPolicies[0] !== "com.langnext.auth.google-service-account"
) {
  throw new Error("Google auth policy mismatch");
}

const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
if (update) {
  fs.writeFileSync(manifestPath, serialized);
  fs.writeFileSync(path.join(stagingRoot, "plugin.json"), serialized);
} else if (!fs.readFileSync(manifestPath).equals(fs.readFileSync(path.join(stagingRoot, "plugin.json")))) {
  throw new Error("staging manifest differs from committed manifest");
}
console.log(`ok: Google Cloud manifest verified (files=${manifest.files.length}, update=${update})`);
