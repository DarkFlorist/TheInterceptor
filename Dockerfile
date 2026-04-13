FROM oven/bun:1.3.12-alpine@sha256:26d8996560ca94eab9ce48afc0c7443825553c9a851f40ae574d47d20906826d AS builder

RUN apk --no-cache add zip

COPY ./build/package.json /build/package.json
COPY ./build/bun.lock /build/bun.lock
WORKDIR /build
RUN bun install --frozen-lockfile

COPY ./package.json /package.json
COPY ./bun.lock /bun.lock
WORKDIR /
RUN bun install --frozen-lockfile

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
