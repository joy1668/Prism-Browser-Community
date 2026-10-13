#!/usr/bin/env node
/**
 * Stages the Xray core that electron-builder bundles as `resources/v2ray/`.
 *
 * `V2rayCore.locate()` resolves a single file name per platform: `xray.exe` on
 * Windows and `xray` on macOS/Linux. The repository ships the Windows binary
 * only, so a macOS build has to replace it with the matching darwin binary
 * before packaging. This script downloads that binary, verifies its SHA-256
 * against the pinned digests in `src/main/v2ray-core.ts`, and writes it here.
 *
 * Usage:
 *   node tools/prepare-bundled-v2ray.mjs --platform darwin-arm64
 *   node tools/prepare-bundled-v2ray.mjs --platform darwin-arm64 --archive ./Xray.zip
 *   node tools/prepare-bundled-v2ray.mjs --list
 *
 * Without --archive the pinned release is downloaded from the XTLS/Xray-core
 * GitHub release.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile, copyFile, chmod } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = join(projectRoot, 'build', 'v2ray')

/**
 * Must stay in sync with XRAY_RELEASE in src/main/v2ray-core.ts. The digests
 * are the upstream release digests; a mismatch aborts the build.
 */
const RELEASE = {
  version: '26.3.27',
  baseUrl: 'https://github.com/XTLS/Xray-core/releases/download/v26.3.27',
  assets: {
    'win32-x64': {
      name: 'Xray-windows-64.zip',
      sha256: 'd004c39288ce9ada487c6f398c7c545f7d749e44bdfdd59dbc9f865afba4e1ad',
      executable: 'xray.exe'
    },
    'darwin-arm64': {
      name: 'Xray-macos-arm64-v8a.zip',
      sha256: '2e93a67e8aa1936ecefb307e120830fcbd4c643ab9b1c46a2d0838d5f8409eaf',
      executable: 'xray'
    },
    'darwin-x64': {
      name: 'Xray-macos-64.zip',
      sha256: 'f5b0471d3459eff1b82e48af0aeac186abcc3298210070afbbbd8437a4e8b203',
      executable: 'xray'
    },
    'linux-x64': {
      name: 'Xray-linux-64.zip',
      sha256: '23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae',
      executable: 'xray'
    }
  }
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function isNonEmptyFile(path) {
  try {
    const info = await stat(path)
    return info.isFile() && info.size > 1024
  } catch {
    return false
  }
}

async function download(spec, destination) {
  const url = `${RELEASE.baseUrl}/${spec.name}`
  process.stdout.write(`下载 ${spec.name} …\n`)
  const response = await fetch(url, {
    headers: { accept: 'application/octet-stream', 'user-agent': 'Prism-Browser-build' },
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60_000)
  })
  if (!response.ok || !response.body) throw new Error(`Xray 下载失败（HTTP ${response.status}）`)
  const chunks = []
  for await (const chunk of response.body) chunks.push(Buffer.from(chunk))
  await writeFile(destination, Buffer.concat(chunks))
}

async function extract(archive, destination) {
  if (process.platform === 'win32') {
    const escapedArchive = archive.replaceAll("'", "''")
    const escapedDestination = destination.replaceAll("'", "''")
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`
    ], { timeout: 300_000 })
    return
  }
  await execFileAsync('unzip', ['-o', '-q', archive, '-d', destination], { timeout: 300_000 })
}

/** The archive holds the binary at its top level; find it by name. */
async function findBinary(root, executable) {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile() && entry.name === executable) return join(root, entry.name)
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const nested = await findBinary(join(root, entry.name), executable)
      if (nested) return nested
    }
  }
  return undefined
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--list')) {
    for (const [key, spec] of Object.entries(RELEASE.assets)) {
      process.stdout.write(`${key.padEnd(16)} ${RELEASE.version}  ${spec.name}\n`)
    }
    return
  }

  const platformIndex = args.indexOf('--platform')
  const platformKey = platformIndex >= 0
    ? args[platformIndex + 1]
    : `${process.platform}-${process.arch}`
  const spec = RELEASE.assets[platformKey]
  if (!spec) throw new Error(`未知平台 ${platformKey}；可用：${Object.keys(RELEASE.assets).join(', ')}`)

  const archiveIndex = args.indexOf('--archive')
  const localArchive = archiveIndex >= 0 ? resolve(args[archiveIndex + 1]) : undefined

  const staging = await mkdtemp(join(tmpdir(), 'prism-v2ray-'))
  try {
    let archive = localArchive
    if (!archive) {
      archive = join(staging, spec.name)
      await download(spec, archive)
    }

    const actual = await hashFile(archive)
    if (actual !== spec.sha256) {
      throw new Error(`Xray 校验失败：期望 ${spec.sha256}，实际 ${actual}`)
    }
    process.stdout.write(`校验通过：${spec.name}\n`)

    const extracted = join(staging, 'extracted')
    await mkdir(extracted, { recursive: true })
    await extract(archive, extracted)

    const binary = await findBinary(extracted, spec.executable)
    if (!binary) throw new Error(`压缩包中没有找到 ${spec.executable}`)

    await mkdir(outputRoot, { recursive: true })
    // Remove the other platform's binary so only one core ships per package.
    for (const other of new Set(Object.values(RELEASE.assets).map((a) => a.executable))) {
      if (other !== spec.executable) await rm(join(outputRoot, other), { force: true })
    }
    const target = join(outputRoot, spec.executable)
    await copyFile(binary, target)
    await chmod(target, 0o755)

    process.stdout.write(`\nXray 内核已就绪：${target}\n`)
    process.stdout.write(`  版本   ${RELEASE.version}\n`)
    process.stdout.write(`  目标   ${platformKey}\n`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`\n准备内置 Xray 失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
