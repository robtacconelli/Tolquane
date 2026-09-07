#!/usr/bin/env bash
#
# Publish the site to tolquane.com.
#
# Set TARGET to whatever rsync should write to: a directory on this machine, or
# user@host:/path on the server. It is the only line to edit.
#
#     TARGET="user@host:/var/www/tolquane/"
#
# The trailing slash matters on both sides: public/ means "the contents of
# public", not "a directory called public".

set -euo pipefail

TARGET=${TOLQUANE_SITE_TARGET:-st4ck@151.80.44.139:/var/www/tolquane.com/}

if [ -z "$TARGET" ]; then
    echo "deploy.sh: set TARGET at the top of this script (or TOLQUANE_SITE_TARGET)" >&2
    exit 2
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --delete keeps the server free of files this directory no longer has.
# 'docs' is excluded, which under --delete also protects it on the server: the
# documentation site is deployed separately and lives at /docs/.
rsync --archive --compress --human-readable --delete \
      --exclude 'docs' \
      --exclude '.DS_Store' \
      "$@" \
      "$here/public/" "$TARGET"

echo "deployed $here/public/ -> $TARGET"
