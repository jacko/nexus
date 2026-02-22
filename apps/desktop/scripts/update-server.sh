#!/bin/bash
# Simple local update server for testing electron-updater
#
# Usage:
#   1. Build the app:          npm run build:mac (or build:win/build:linux)
#   2. Copy build artifacts:   cp dist/*.yml dist/*.zip dist/*.dmg scripts/updates/
#   3. Start the server:       bash scripts/update-server.sh
#   4. Run the OLD version of the app — it will detect the "new" version
#
# To simulate an update:
#   - Build v1.0.0, install it
#   - Bump version to 1.1.0 in package.json, rebuild
#   - Copy the v1.1.0 artifacts to scripts/updates/
#   - Start this server
#   - Launch the installed v1.0.0 — it should detect v1.1.0

DIR="$(cd "$(dirname "$0")" && pwd)"
UPDATES_DIR="$DIR/updates"

mkdir -p "$UPDATES_DIR"

if [ -z "$(ls -A "$UPDATES_DIR" 2>/dev/null)" ]; then
  echo "No update files found in $UPDATES_DIR"
  echo ""
  echo "To set up:"
  echo "  1. npm run build:mac"
  echo "  2. cp dist/latest-mac.yml dist/*.zip $UPDATES_DIR/"
  echo "  3. Re-run this script"
  exit 1
fi

echo "Serving updates from: $UPDATES_DIR"
echo "URL: http://127.0.0.1:8080/updates/"
echo ""
echo "Files:"
ls -la "$UPDATES_DIR"
echo ""
echo "Press Ctrl+C to stop"

cd "$UPDATES_DIR"
python3 -m http.server 8080 --bind 127.0.0.1 2>/dev/null &
PID=$!

# Rewrite requests from /updates/* to serve from current dir
# python's http.server serves from CWD, so we need a small wrapper
kill $PID 2>/dev/null

python3 -c "
import http.server
import os
import sys

class UpdateHandler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # Strip query string (electron-updater adds ?noCache=...)
        path = path.split('?')[0]
        # Strip /updates/ prefix
        if path.startswith('/updates/'):
            path = path[len('/updates/'):]
        elif path.startswith('/updates'):
            path = path[len('/updates'):]
        if not path.startswith('/'):
            path = '/' + path
        return os.path.join('$UPDATES_DIR', path.lstrip('/'))

    def log_message(self, format, *args):
        print(f'[update-server] {args[0]}')
        sys.stdout.flush()

print('Update server running at http://127.0.0.1:8080/updates/')
http.server.HTTPServer(('127.0.0.1', 8080), UpdateHandler).serve_forever()
"
