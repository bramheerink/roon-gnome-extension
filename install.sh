#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_UUID="roon@gnome.extensions"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"

echo "=== Roon GNOME Extension Installer ==="

# Install bridge dependencies
echo ""
echo "1. Installing bridge dependencies..."
cd "$SCRIPT_DIR/bridge"
npm install

# Create symlink for GNOME extension
echo ""
echo "2. Creating symlink for GNOME Shell extension..."
mkdir -p "$(dirname "$EXTENSION_DIR")"
rm -f "$EXTENSION_DIR"  # Remove if exists
ln -s "$SCRIPT_DIR/extension" "$EXTENSION_DIR"

# Compile schemas
echo ""
echo "3. Compiling GSettings schemas..."
glib-compile-schemas "$SCRIPT_DIR/extension/schemas/"

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Next steps:"
echo "1. Start the bridge:  cd $SCRIPT_DIR/bridge && node index.js"
echo "2. In Roon: Settings -> Extensions -> Enable 'GNOME Integration'"
echo "3. Restart GNOME Shell: Alt+F2, type 'r', press Enter (X11) or log out/in (Wayland)"
echo "4. Enable extension: gnome-extensions enable $EXTENSION_UUID"
echo ""
