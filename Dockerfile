# Tolquane Web in a container.
#
#   docker build -t tolquane:local .                        # the released wheel from PyPI
#   docker build -t tolquane:local --build-arg SOURCE=local .   # this checkout instead
#
#   docker run --rm -p 127.0.0.1:8765:8765 \
#     -e TOLQUANE_WEB_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(24))')" \
#     -v "$PWD/flows:/workspace" -v tolquane-data:/data tolquane:local
#
# Two volumes, and nothing else is worth keeping:
#   /workspace   the flow files: `flow.py`, its layout sidecar, and a git repository
#   /data        TOLQUANE_HOME: `web.db` (runs, schedules, settings, users) and
#                `web.toml` (the API keys and the SMTP password, mode 600)
#
# The server binds 0.0.0.0 inside the container, so it insists on a token: set
# TOLQUANE_WEB_TOKEN. Publish the port on 127.0.0.1 and put HTTPS in front of it
# (docker-compose.yml has a Caddy service, commented, for that). See docs/deploy.md.
#
# `SOURCE=local` installs the checkout instead of the wheel. It uses the built GUI in
# `src/tolquane/web/static`, so build the frontend first -- `npm --prefix web ci &&
# npm --prefix web run build` -- or the image comes up without a page to serve.

ARG PYTHON_VERSION=3.13
ARG SOURCE=pypi

# --------------------------------------------------------------------------- base

FROM python:${PYTHON_VERSION}-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# git is what the History tab is: without it that tab says so and everything else works.
# tzdata is for the schedules, which fire in the machine's own zone, and sqlite3 is for
# taking a consistent copy of web.db while the server is running.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git sqlite3 tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system --add safe.directory /workspace

RUN useradd --create-home --uid 1000 tolquane

# --------------------------------------------------------- where the package comes from

FROM base AS pypi
# Pin it if you would rather: --build-arg TOLQUANE_SPEC="tolquane[web,ai]==1.3.0"
ARG TOLQUANE_SPEC="tolquane[web,ai]"
RUN pip install --no-cache-dir "${TOLQUANE_SPEC}"

FROM base AS local
COPY . /src
RUN pip install --no-cache-dir "/src[web,ai]" && rm -rf /src

# --------------------------------------------------------------------------- the image

FROM ${SOURCE} AS final

COPY docker-entrypoint.sh /usr/local/bin/tolquane-entrypoint
RUN chmod 755 /usr/local/bin/tolquane-entrypoint \
    && mkdir -p /workspace /data \
    && chown tolquane:tolquane /workspace /data

# TOLQUANE_HOME moves the database and the key file off the container's own filesystem.
ENV TOLQUANE_HOME=/data \
    TOLQUANE_WEB_HOST=0.0.0.0 \
    TOLQUANE_WEB_PORT=8765 \
    TOLQUANE_WEB_WORKSPACE=/workspace

VOLUME ["/workspace", "/data"]
EXPOSE 8765
USER tolquane
WORKDIR /workspace

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import os,sys,urllib.request; url='http://127.0.0.1:'+os.environ.get('TOLQUANE_WEB_PORT','8765')+'/api/health'; sys.exit(0 if urllib.request.urlopen(url, timeout=4).status == 200 else 1)"]

# The entrypoint runs `tolquane web --host ... --port ... --workspace ... --no-browser`,
# with `--token "$TOLQUANE_WEB_TOKEN"` when that variable is set. Any command given to
# `docker run` replaces it, so `docker run --rm -it IMAGE tolquane web users list` works.
ENTRYPOINT ["/usr/local/bin/tolquane-entrypoint"]
CMD []
