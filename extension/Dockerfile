# node:16.16.0-alpine3.16
FROM node@sha256:554142f9a6367f1fbd776a1b2048fab3a2cc7aa477d7fe9c00ce0f110aa45716

RUN apk --no-cache add zip

COPY ./build/package.json /extension/build/package.json
COPY ./build/package-lock.json /extension/build/package-lock.json
WORKDIR /extension/build
RUN npm ci

COPY ./inpage/package.json ./inpage/package-lock.json ./inpage/tsconfig.json ./inpage/output_tsconfig.json /extension/inpage/
COPY ./package.json /extension/package.json
COPY ./package-lock.json /extension/package-lock.json
WORKDIR /extension
RUN npm ci

COPY tsconfig.json /extension/
COPY app/*.png app/*.jpg app/*.json app/*.ico /extension/app/
COPY app/html/ /extension/app/html/
COPY app/css/ /extension/app/css/
COPY app/ts/ /extension/app/ts/
COPY app/img/ /extension/app/img/
COPY app/inpage/ /extension/app/inpage/
COPY build/tsconfig.json build/vendor.ts /extension/build/

COPY tsconfig-test.json /extension/
COPY test/ /extension/test/

WORKDIR /extension/build
RUN npm run vendor

WORKDIR /extension
RUN npm run inpage
RUN npm run build-firefox
RUN npm run test

WORKDIR /extension/app
RUN zip ../interceptor.zip -r .
