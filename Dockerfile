FROM node:22-slim

WORKDIR /app
RUN chown node:node /app

# Best-effort defensive measure: this host's Docker bridge network has shown
# outbound IPv6 connections stall without an error, which can hang npm mid
# install. Prefer IPv4 DNS results so npm/tsc's install step doesn't attempt
# a route that may not work.
ENV NODE_OPTIONS=--dns-result-order=ipv4first

# Claude/Codex OAuth is 9router's responsibility (see README), so this image
# does not need the Claude Code / Codex CLIs installed just to run
# `usage-auth` — that script (and its `npm install -g` step, which was also
# the slowest and most failure-prone layer in this build) is retired along
# with the credential volume it renewed. `curl`/`less` stay for general
# container debugging via the Dokploy terminal.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl less \
    && rm -rf /var/lib/apt/lists/*

# Persistent data directory for history (created as root before USER node)
RUN mkdir -p /home/node/data && chown node:node /home/node/data
VOLUME /home/node/data

COPY scripts/docker-entrypoint.sh /usr/local/bin/usage-api-entrypoint
RUN chmod 755 /usr/local/bin/usage-api-entrypoint

USER node

COPY --chown=node:node package.json package-lock.json* ./
RUN npm install --omit=dev=false

COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node oauth ./oauth
COPY --chown=node:node public ./public
RUN npx tsc

ENV PORT=3000
EXPOSE 3000

ENV USAGE_HISTORY_FILE=/home/node/data/usage-history.jsonl

CMD ["usage-api-entrypoint"]
