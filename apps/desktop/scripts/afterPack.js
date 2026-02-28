const { execSync } = require('child_process')
const { readdirSync, statSync } = require('fs')
const path = require('path')

function signRecursive(dir) {
  // Two-pass: recurse into all directories first, then sign files.
  // This ensures nested executables (e.g. Helpers/chrome_crashpad_handler)
  // are signed before the parent binary that references them.
  const entries = readdirSync(dir)
  const files = []

  for (const entry of entries) {
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      signRecursive(full)
      if (entry.endsWith('.app') || entry.endsWith('.framework')) {
        execSync(`codesign --force --sign - "${full}"`, { stdio: 'pipe' })
      }
    } else {
      files.push({ entry, full, stat })
    }
  }

  // Sign files after all subdirectories have been processed
  for (const { entry, full, stat } of files) {
    if (entry.endsWith('.dylib') || entry.endsWith('.node') ||
        (!path.extname(entry) && (stat.mode & 0o111))) {
      execSync(`codesign --force --sign - "${full}"`, { stdio: 'pipe' })
    }
  }
}

exports.default = async function afterPack(context) {
  if (process.platform !== 'darwin') return

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  console.log(`  • ad-hoc signing  app=${appPath}`)

  // Sign inner frameworks and helpers first
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks')
  signRecursive(frameworksDir)

  // Sign the top-level app last
  execSync(`codesign --force --sign - "${appPath}"`, { stdio: 'inherit' })
}
