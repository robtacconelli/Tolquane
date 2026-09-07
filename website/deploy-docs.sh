#!/bin/sh
# Build the documentation with tolquane.com/docs as its base URL and put it on the server.
#
#   ./website/deploy-docs.sh            # after `pip install -e ".[docs]"`
#
# The landing page is deployed by ./website/deploy.sh, which leaves /docs alone.
set -eu
cd "$(dirname "$0")/.."
TARGET=${TOLQUANE_SITE_TARGET:-st4ck@151.80.44.139:/var/www/tolquane.com/}
out=$(mktemp -d "${TMPDIR:-/tmp}/tolquane-docs.XXXXXX")
trap 'rm -rf "$out"' EXIT
.venv/bin/mkdocs build --strict -f mkdocs.tolquane.yml -d "$out"
rsync --archive --delete --compress "$out/" "${TARGET%/}/docs/"
echo "deployed the docs -> ${TARGET%/}/docs/"
