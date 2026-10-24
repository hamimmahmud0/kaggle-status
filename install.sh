#!/usr/bin/env bash
# Installs the extension into ~/.local/share/gnome-shell/extensions and
# points it at this repo's .token directory.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
uuid="$(sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' "$here/src/metadata.json")"
dest="$HOME/.local/share/gnome-shell/extensions/$uuid"
glib-compile-schemas --strict "$here/src/schemas"
mkdir -p "$dest"
rsync -a --delete "$here/src/" "$dest/"
if [ -d "$here/.token" ]; then
  gsettings --schemadir "$dest/schemas" set org.gnome.shell.extensions.kaggle-status token-dir "$here/.token"
fi
echo "Installed to $dest"
echo "Wayland: log out and back in once so GNOME Shell discovers it, then run:"
echo "  gnome-extensions enable $uuid"
