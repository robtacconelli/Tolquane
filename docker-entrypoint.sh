#!/bin/sh
# Start Tolquane Web in the container.
#
# `tolquane web` takes its access token as `--token`, not from the environment, so this
# turns TOLQUANE_WEB_TOKEN into that flag. Everything else is the plain command:
#
#     tolquane web --host 0.0.0.0 --port 8765 --workspace /workspace --no-browser
#
# A command given to `docker run` replaces all of this, which is how the command-line
# tools are reached: `docker run --rm -it IMAGE tolquane web users add alice --admin`.

set -eu

if [ "$#" -gt 0 ]; then
    exec "$@"
fi

host=${TOLQUANE_WEB_HOST:-0.0.0.0}
port=${TOLQUANE_WEB_PORT:-8765}
workspace=${TOLQUANE_WEB_WORKSPACE:-/workspace}

set -- tolquane web --host "$host" --port "$port" --workspace "$workspace" --no-browser

if [ -n "${TOLQUANE_WEB_TOKEN:-}" ]; then
    set -- "$@" --token "$TOLQUANE_WEB_TOKEN"
else
    case "$host" in
        127.0.0.1 | localhost | ::1) ;;
        *)
            # The server is about to refuse, and its message asks for a flag nobody can
            # pass to a container. Say what to do instead.
            echo "tolquane: listening on $host needs an access token." >&2
            echo "tolquane: set TOLQUANE_WEB_TOKEN in the container's environment, e.g." >&2
            echo "tolquane:   -e TOLQUANE_WEB_TOKEN=\"\$(python -c 'import secrets; print(secrets.token_urlsafe(24))')\"" >&2
            ;;
    esac
fi

exec "$@"
