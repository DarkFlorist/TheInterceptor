FROM node:18.16.0-alpine3.17@sha256:44aaf1ccc80eaed6572a0f2ef7d6b5a2982d54481e4255480041ac92221e2f11

RUN apk --no-cache add bash curl unzip zip
RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL=/root/.bun
ENV PATH="${BUN_INSTALL}/bin:${PATH}"

COPY ./build/package.json /build/package.json
COPY ./build/bun.lock /build/bun.lock
WORKDIR /build
RUN bun install --frozen-lockfile --ignore-scripts

COPY ./package.json /package.json
COPY ./bun.lock /bun.lock
WORKDIR /
RUN bun install --frozen-lockfile --ignore-scripts

COPY tsconfig.json tsconfig-inpage.json /
COPY app/*.png app/*.jpg app/*.json app/*.ico /app/
COPY app/html/ /app/html/
COPY app/html3/ /app/html3/
COPY app/css/ /app/css/
COPY app/ts/ /app/ts/
COPY app/img/ /app/img/
COPY app/inpage/ /app/inpage/
COPY app/fonts/ /app/fonts/
COPY build/tsconfig.json build/vendor.mts build/bundler.mts /build/

COPY tsconfig-test.json /
COPY test/ /test/

WORKDIR /
RUN bun run setup-firefox
RUN bun run test

WORKDIR /app
RUN zip ../interceptor-firefox.zip -r .

WORKDIR /
RUN bun run setup-chrome

WORKDIR /app
RUN zip ../interceptor-chrome.zip -r .
