FROM oven/bun:1.3.12-alpine@sha256:26d8996560ca94eab9ce48afc0c7443825553c9a851f40ae574d47d20906826d AS builder

RUN apk --no-cache add zip

COPY ./build/package.json /workspace/build/package.json
COPY ./build/bun.lock /workspace/build/bun.lock
WORKDIR /workspace/build
RUN bun install --frozen-lockfile

COPY ./package.json /workspace/package.json
COPY ./bun.lock /workspace/bun.lock
WORKDIR /workspace
RUN bun install --frozen-lockfile

COPY tsconfig.json tsconfig-inpage.json /workspace/
COPY app/*.png app/*.jpg app/*.json app/*.ico /workspace/app/
COPY app/html/ /workspace/app/html/
COPY app/html3/ /workspace/app/html3/
COPY app/css/ /workspace/app/css/
COPY app/ts/ /workspace/app/ts/
COPY app/img/ /workspace/app/img/
COPY app/inpage/ /workspace/app/inpage/
COPY app/fonts/ /workspace/app/fonts/
COPY build/tsconfig.json build/vendor.mts build/bundler.mts /workspace/build/

COPY tsconfig-test.json /workspace/
COPY test/ /workspace/test/

WORKDIR /workspace
RUN bun run setup-firefox
RUN bun run test

WORKDIR /workspace/app
RUN zip ../interceptor-firefox.zip -r .

WORKDIR /workspace
RUN bun run setup-chrome

WORKDIR /workspace/app
RUN zip ../interceptor-chrome.zip -r .

WORKDIR /workspace
RUN mv interceptor-*.zip app/
