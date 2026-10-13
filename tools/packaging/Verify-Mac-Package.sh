#!/usr/bin/env bash
#
# Fails-closed acceptance check for a packaged macOS app.
#
# Referenced by tools/release/Build-Mac-Release.sh. Verifies, in order:
#   1. the .app exists and its bundle identifier is the expected one;
#   2. the bundled fingerprint kernel is present and its manifest digests match;
#   3. when PRISM_REQUIRE_DISTRIBUTION_SIGNATURE=1, the app carries a Developer ID
#      signature, passes Gatekeeper assessment, and has a stapled notarization
#      ticket.
#
# Usage:
#   tools/packaging/Verify-Mac-Package.sh "/path/to/Prism Browser.app"
#
set -euo pipefail

app_path="${1:-}"
[[ -n "$app_path" ]] || { echo "Usage: $0 /path/to/App.app" >&2; exit 2; }
[[ -d "$app_path" && "$app_path" == *.app ]] || { echo "Not a .app bundle: $app_path" >&2; exit 2; }

expected_bundle_id="com.prismbrowser.desktop"
fail() { echo "macOS package verification failed: $*" >&2; exit 1; }

# 1. Bundle identity.
plist="$app_path/Contents/Info.plist"
[[ -f "$plist" ]] || fail "missing Info.plist"
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist" 2>/dev/null || true)"
[[ "$bundle_id" == "$expected_bundle_id" ]] || fail "unexpected bundle id '$bundle_id' (expected $expected_bundle_id)"
echo "bundle id: $bundle_id"

# 2. Bundled kernel manifest and digest.
kernel_root="$app_path/Contents/Resources/kernels/current"
manifest="$kernel_root/manifest.json"
[[ -f "$manifest" ]] || fail "no bundled kernel manifest at Resources/kernels/current/manifest.json"
KERNEL_ROOT="$kernel_root" KERNEL_MANIFEST="$manifest" node --input-type=commonjs - <<'NODE'
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { readFile, stat } = require('node:fs/promises')
const { join } = require('node:path')

const root = process.env.KERNEL_ROOT
const manifestPath = process.env.KERNEL_MANIFEST

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

;(async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.schemaVersion !== 2) throw new Error(`unexpected kernel schemaVersion ${manifest.schemaVersion}`)
  if (manifest.target !== 'darwin-arm64') throw new Error(`kernel target is ${manifest.target}, expected darwin-arm64`)
  if (!Array.isArray(manifest.criticalFiles) || !manifest.criticalFilesSha256) {
    throw new Error('kernel manifest is missing critical file digests')
  }
  const aggregate = createHash('sha256')
  for (const file of manifest.criticalFiles) {
    const absolute = join(root, file.path)
    const info = await stat(absolute)
    if (info.size !== file.size) throw new Error(`size mismatch for ${file.path}`)
    const digest = await hashFile(absolute)
    if (digest !== file.sha256) throw new Error(`digest mismatch for ${file.path}`)
    aggregate.update(`${file.path}\0${file.size}\0${file.sha256}\n`)
  }
  if (aggregate.digest('hex') !== manifest.criticalFilesSha256) {
    throw new Error('aggregate criticalFilesSha256 does not match')
  }
  console.log(`kernel manifest ok: ${manifest.version} (${manifest.criticalFiles.length} files)`)
})().catch((error) => {
  console.error(`kernel verification failed: ${error.message}`)
  process.exit(1)
})
NODE

# 3. Distribution signature, Gatekeeper and notarization ticket.
if [[ "${PRISM_REQUIRE_DISTRIBUTION_SIGNATURE:-0}" == "1" ]]; then
  codesign --verify --deep --strict --verbose=2 "$app_path" || fail "codesign verification failed"
  signature="$(codesign -dv --verbose=4 "$app_path" 2>&1 || true)"
  grep -q 'Authority=Developer ID Application' <<<"$signature" \
    || fail "app is not signed with a Developer ID Application certificate"
  grep -q '^TeamIdentifier=' <<<"$signature" || fail "signature has no TeamIdentifier"
  spctl --assess --type execute --verbose=4 "$app_path" || fail "Gatekeeper assessment failed"
  xcrun stapler validate "$app_path" || fail "no valid stapled notarization ticket"
  echo "distribution signature ok"
fi

echo "macOS package verification passed: $app_path"
