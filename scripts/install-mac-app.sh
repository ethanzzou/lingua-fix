#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="LinguaFix"
APP_ID="com.ehanzou.linguafix"
BUILD_DIR="$ROOT_DIR/dist/macos"
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"
INSTALL_PATH="/Applications/$APP_NAME.app"
ELECTRON_TEMPLATE_APP="$ROOT_DIR/node_modules/electron/dist/Electron.app"
INFO_PLIST="$APP_BUNDLE/Contents/Info.plist"
MACOS_DIR="$APP_BUNDLE/Contents/MacOS"
RESOURCES_DIR="$APP_BUNDLE/Contents/Resources"
APP_RESOURCES_DIR="$RESOURCES_DIR/app"
PLIST_BUDDY="/usr/libexec/PlistBuddy"

set_plist_value() {
  local key="$1"
  local type="$2"
  local value="$3"

  "$PLIST_BUDDY" -c "Delete :$key" "$INFO_PLIST" >/dev/null 2>&1 || true
  "$PLIST_BUDDY" -c "Add :$key $type $value" "$INFO_PLIST"
}

cd "$ROOT_DIR"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to package LinguaFix."
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required to package LinguaFix."
  exit 1
fi

if [ ! -d node_modules ]; then
  npm install
fi

if [ ! -d frontend/node_modules ]; then
  npm --prefix frontend install
fi

npm run build

rm -rf "$APP_BUNDLE"
mkdir -p "$BUILD_DIR"
ditto "$ELECTRON_TEMPLATE_APP" "$APP_BUNDLE"

mv "$MACOS_DIR/Electron" "$MACOS_DIR/$APP_NAME"

set_plist_value "CFBundleDisplayName" "string" "$APP_NAME"
set_plist_value "CFBundleName" "string" "$APP_NAME"
set_plist_value "CFBundleExecutable" "string" "$APP_NAME"
set_plist_value "CFBundleIdentifier" "string" "$APP_ID"
set_plist_value "CFBundleIconFile" "string" "linguafix-app-icon-v1"

mkdir -p "$APP_RESOURCES_DIR/electron" "$APP_RESOURCES_DIR/frontend"
cp "$ROOT_DIR/package.json" "$APP_RESOURCES_DIR/package.json"
cp "$ROOT_DIR/electron/main.cjs" "$ROOT_DIR/electron/preload.cjs" "$APP_RESOURCES_DIR/electron/"
ditto "$ROOT_DIR/frontend/dist" "$APP_RESOURCES_DIR/frontend/dist"

mkdir -p "$RESOURCES_DIR/bin"
cp "$ROOT_DIR/target/release/linguafix" "$RESOURCES_DIR/bin/linguafix"
chmod +x "$RESOURCES_DIR/bin/linguafix" "$MACOS_DIR/$APP_NAME"

cp "$ROOT_DIR/electron/assets/statusbarTemplate.png" "$RESOURCES_DIR/statusbarTemplate.png"
cp "$ROOT_DIR/electron/assets/linguafix-app-icon-v2-512.png" "$RESOURCES_DIR/linguafix-app-icon-v2-512.png"
cp "$ROOT_DIR/electron/assets/linguafix-app-icon-v1.icns" "$RESOURCES_DIR/linguafix-app-icon-v1.icns"

codesign --force --deep --sign - "$APP_BUNDLE" >/dev/null

rm -rf "$INSTALL_PATH"
ditto "$APP_BUNDLE" "$INSTALL_PATH"

codesign --force --deep --sign - "$INSTALL_PATH" >/dev/null

echo "Installed $INSTALL_PATH"
