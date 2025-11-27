FROM node:20-bookworm

ARG LOCAL_UID=1000
ARG LOCAL_GID=1000

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    bash \
    python3 \
    python3-pip \
    build-essential \
    openssl \
  && rm -rf /var/lib/apt/lists/*

RUN if [ "${LOCAL_GID}" != "1000" ]; then groupmod -g ${LOCAL_GID} node; fi \
  && if [ "${LOCAL_UID}" != "1000" ]; then usermod -u ${LOCAL_UID} node; fi \
  && corepack enable \
  && corepack prepare pnpm@9 --activate

WORKDIR /app
USER node

CMD ["sleep", "infinity"]
