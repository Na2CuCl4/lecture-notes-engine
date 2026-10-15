# syntax=docker/dockerfile:1
# Keep Node major and Debian suite fixed; refresh the image regularly for patches.
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    RELEASES_DIR=/releases \
    CURRENT_FILE=/releases/current.json \
    STATE_DIR=/state
WORKDIR /app
# Named volumes inherit these ownerships on their first mount. Nothing needs to
# chmod/chown the host's content repository or run the application as root.
RUN mkdir -p /releases /state \
    && ln -s /releases/.astro-cache /app/.astro \
    && chown -h node:node /app/.astro \
    && chown node:node /releases /state
EXPOSE 3000

# Install the large, rarely changing TeX toolchain before copying application
# sources, so ordinary engine changes do not invalidate the apt layer.
FROM runtime AS compiler-runtime
ARG APT_MIRROR=deb.debian.org
RUN sed -i "s/deb.debian.org/${APT_MIRROR}/g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        fontconfig \
        util-linux \
        pandoc \
        texlive-xetex \
        texlive-lang-chinese \
        texlive-latex-extra \
        texlive-fonts-recommended \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f \
    && kpsewhich ctexart.cls \
    && kpsewhich FandolSong-Regular.otf
ENV CONTENT_DIR=/content \
    TEXMFVAR=/state/texmf-var \
    TEXMFCONFIG=/state/texmf-config \
    TEXMFHOME=/state/texmf-home
USER node

FROM runtime AS web
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=node:node . .
USER node
CMD ["npm", "run", "start"]

FROM compiler-runtime AS compiler
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=node:node . .
CMD ["npm", "run", "worker"]
