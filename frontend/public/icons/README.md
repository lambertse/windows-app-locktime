# App Icons

Place your application icons here before building:

- `icon.ico` — Windows icon (256x256 recommended, multi-size ICO)
- `icon.icns` — macOS icon (1024x1024 recommended)
- `icon.png` — Linux / fallback (512x512 PNG)

## Generating icons

You can generate these from a single high-resolution PNG using tools like:

- [electron-icon-maker](https://github.com/jaretburkett/electron-icon-maker): `electron-icon-maker --input=icon-1024.png --output=./`
- [icns-gen](https://github.com/nicktindall/icns-gen) for macOS `.icns`
- ImageMagick: `convert icon-1024.png -resize 256x256 icon.ico`

## electron-builder expectations

`electron-builder.yml` references:
- `public/icons/icon.ico` for Windows builds
- `public/icons/icon.icns` for macOS builds
