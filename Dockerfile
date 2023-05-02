FROM node:18.16.0-alpine3.17@sha256:44aaf1ccc80eaed6572a0f2ef7d6b5a2982d54481e4255480041ac92221e2f11

RUN apk --no-cache add zip

WORKDIR /build
RUN npm ci

WORKDIR /
RUN npm ci
RUN npm run setup-firefox
RUN npm run test

WORKDIR /app
RUN zip ../interceptor-firefox.zip -r .

WORKDIR /
RUN npm run setup-chrome

WORKDIR /app
RUN zip ../interceptor-chrome.zip -r .
