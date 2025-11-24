FROM node:20-alpine

ARG LOCAL_UID=1000
ARG LOCAL_GID=1000

RUN sed -i 's|https://dl-cdn.alpinelinux.org|https://mirrors.aliyun.com|g' /etc/apk/repositories \
  && apk add --no-cache bash git openssh-client python3 make g++ shadow \
  && if [ "${LOCAL_GID}" != "1000" ]; then groupmod -g ${LOCAL_GID} node; fi \
  && if [ "${LOCAL_UID}" != "1000" ]; then usermod -u ${LOCAL_UID} node; fi \
  && corepack enable

WORKDIR /app
USER node
CMD ["sleep", "infinity"]
