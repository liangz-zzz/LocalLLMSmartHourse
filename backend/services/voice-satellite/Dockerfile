FROM python:3.10-bookworm

ARG LOCAL_UID=1000
ARG LOCAL_GID=1000
ARG PIPER_VERSION=2023.11.14-2

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    ffmpeg \
    libportaudio2 \
    portaudio19-dev \
    libasound2 \
    libasound2-dev \
  && rm -rf /var/lib/apt/lists/*

# Install Piper TTS binary (offline runtime; downloads only at image build time).
RUN set -eu; \
  arch="$(dpkg --print-architecture)"; \
  case "${arch}" in \
    amd64) asset="piper_linux_x86_64.tar.gz" ;; \
    arm64) asset="piper_linux_aarch64.tar.gz" ;; \
    armhf) asset="piper_linux_armv7l.tar.gz" ;; \
    *) echo "Unsupported architecture for Piper: ${arch}" >&2; exit 1 ;; \
  esac; \
  url="https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/${asset}"; \
  echo "Downloading Piper: ${url}"; \
  mkdir -p /opt/piper; \
  curl -fsSL "${url}" -o /tmp/piper.tar.gz; \
  tar -xzf /tmp/piper.tar.gz -C /opt/piper --strip-components=1; \
  ln -sf /opt/piper/piper /usr/local/bin/piper; \
  rm -f /tmp/piper.tar.gz

# Create an unprivileged user matching the host UID/GID for mounted volumes.
RUN groupadd -g 1000 app \
  && useradd -m -u 1000 -g 1000 app \
  && if [ "${LOCAL_GID}" != "1000" ]; then groupmod -g ${LOCAL_GID} app; fi \
  && if [ "${LOCAL_UID}" != "1000" ]; then usermod -u ${LOCAL_UID} app; fi \
  && usermod -a -G audio app || true

WORKDIR /app
COPY requirements.txt /app/requirements.txt
ARG TORCH_VERSION=2.2.2+cpu
ARG TORCHAUDIO_VERSION=2.2.2+cpu
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu \
    "torch==${TORCH_VERSION}" \
    "torchaudio==${TORCHAUDIO_VERSION}"
RUN pip install --no-cache-dir -r /app/requirements.txt

USER app

# Keep container alive for devcontainer / manual run.
CMD ["sleep", "infinity"]
