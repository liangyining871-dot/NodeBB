ARG NODE_VERSION=24.11.1
FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV NODE_ENV=production USER=nodebb UID=1001 GID=1001
WORKDIR /usr/src/app
RUN apt-get -o Acquire::Retries=3 update \
    && for attempt in 1 2 3; do \
         if DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 install -y --no-install-recommends postgresql tini; then break; fi; \
         test "$attempt" != 3 || exit 1; \
       done \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1001 nodebb && useradd -u 1001 -g 1001 -m nodebb
RUN chown 1001:1001 /usr/src/app
COPY --chown=1001:1001 install/package.json ./package.json
COPY --chown=1001:1001 package-lock.json ./package-lock.json
COPY --chown=1001:1001 plugins ./plugins
COPY --chown=1001:1001 scripts ./scripts
USER nodebb
# Keep downloaded tarballs across failed builds; retry transient registry resets.
# Cache ownership must match the non-root build user.
RUN --mount=type=cache,target=/home/nodebb/.npm,uid=1001,gid=1001 \
    for attempt in 1 2 3; do \
      if npm ci --omit=dev --no-audit --no-fund \
          --fetch-retries=5 --fetch-retry-mintimeout=10000 \
          --fetch-retry-maxtimeout=60000 --fetch-timeout=300000; then break; fi; \
      test "$attempt" != 3 || exit 1; \
    done
COPY --chown=1001:1001 . .
RUN cp install/package.json package.json && sed -i 's/\r$//' install/docker/*.sh
RUN bash install/docker/build-offline.sh

FROM node:${NODE_VERSION}-bookworm-slim AS final
ENV NODE_ENV=production USER=nodebb UID=1001 GID=1001 \
    DAEMON=false SILENT=false PORT=9203 port=9203 OFFLINE_DEPLOYMENT=true \
    INITIAL_APPEARANCE_SNAPSHOT=/usr/src/app/install/docker/appearance.snapshot.json
WORKDIR /usr/src/app
RUN groupadd -g 1001 nodebb && useradd -u 1001 -g 1001 -m nodebb \
    && mkdir -p /opt/config && chown 1001:1001 /opt/config
COPY --from=build --chown=1001:1001 /usr/src/app/ ./
COPY --from=build /usr/bin/tini /usr/local/bin/tini
COPY --from=build /usr/src/app/install/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/tini
USER nodebb
EXPOSE 9203
ENTRYPOINT ["tini", "--", "entrypoint.sh"]
