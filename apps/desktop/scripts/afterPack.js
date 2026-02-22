const { execSync } = require('child_process')
const { readdirSync, statSync } = require('fs')
const path = require('path')

function signRecursive(dir) {
  // Sign innermost components first, then work outward
  const entries = readdirSync(dir)
  for (const entry of entries) {
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      signRecursive(full)
      // Sign .app, .framework, .dylib bundles
      if (entry.endsWith('.app') || entry.endsWith('.framework')) {
        execSync(`codesign --force --sign - "${full}"`, { stdio: 'pipe' })
      }
    } else if (entry.endsWith('.dylib') || entry.endsWith('.node')) {
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
