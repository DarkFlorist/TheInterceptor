FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS builder

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
COPY contracts/ /workspace/contracts/
COPY build/tsconfig.json build/vendor.mts build/bundler.mts build/cleanOutput.mts build/compileSolidityContracts.mts /workspace/build/

COPY tsconfig-test.json /workspace/
COPY test/ /workspace/test/
COPY scripts/ /workspace/scripts/

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
RUN mv interceptor-firefox.zip /interceptor-firefox.zip && mv interceptor-chrome.zip /interceptor-chrome.zip
