// notarize.js — macOS notarization hook for electron-builder afterSign
// Notarization is skipped unless APPLE_ID and APPLE_APP_SPECIFIC_PASSWORD are set.
// Set these in CI/CD environment when releasing.

exports.default = async function notarize(context) {
  const { electronPlatformName, appOutDir } = context

  if (electronPlatformName !== 'darwin') return
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD) {
    console.log('[notarize] Skipping notarization — APPLE_ID not set')
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = `${appOutDir}/${appName}.app`

  const { notarize } = await import('@electron/notarize')

  console.log(`[notarize] Notarizing ${appPath}...`)
  await notarize({
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  })
  console.log('[notarize] Done')
}
