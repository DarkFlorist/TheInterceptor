FROM oven/bun:1.3.13-alpine@sha256:4de475389889577f346c636f956b42a5c31501b654664e9ae5726f94d7bb5349 AS builder

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
COPY build/tsconfig.json build/vendor.mts build/bundler.mts build/cleanOutput.mts /workspace/build/

COPY tsconfig-test.json /workspace/
COPY test/ /workspace/test/
COPY scripts/ /workspace/scripts/

WORKDIR /workspace
RUN bun run setup-firefox
RUN bun test

WORKDIR /workspace/app
RUN zip ../interceptor-firefox.zip -r .

WORKDIR /workspace
RUN bun run setup-chrome

WORKDIR /workspace/app
RUN zip ../interceptor-chrome.zip -r .

WORKDIR /workspace
RUN mv interceptor-firefox.zip /interceptor-firefox.zip && mv interceptor-chrome.zip /interceptor-chrome.zip
