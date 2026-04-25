FROM mcr.microsoft.com/devcontainers/javascript-node:1-20-bullseye

USER root

RUN apt-get update && apt-get install -y --no-install-recommends curl unzip && rm -rf /var/lib/apt/lists/*

ENV BUN_INSTALL=/usr/local/bun
ENV PATH=${BUN_INSTALL}/bin:${PATH}

RUN mkdir -p "${BUN_INSTALL}" && curl -fsSL https://bun.sh/install | bash -s -- bun-v1.3.12

USER node
