FROM node:18.16.0-alpine3.17@sha256:44aaf1ccc80eaed6572a0f2ef7d6b5a2982d54481e4255480041ac92221e2f11

RUN apk --no-cache add zip

COPY ./build/package.json /build/package.json
COPY ./build/package-lock.json /build/package-lock.json
WORKDIR /build
RUN npm ci

COPY ./package.json /package.json
COPY ./package-lock.json /package-lock.json
WORKDIR /
RUN npm ci

COPY tsconfig.json tsconfig-inpage.json tsconfig-inpage-output.json tsconfig-inpage-create-injection-script.json /
COPY app/*.png app/*.jpg app/*.json app/*.ico /app/
COPY app/html/ /app/html/
COPY app/html3/ /app/html3/
COPY app/css/ /app/css/
COPY app/ts/ /app/ts/
COPY app/img/ /app/img/
COPY app/inpage/ /app/inpage/
COPY build/tsconfig.json build/vendor.mts build/bundler.mts /build/

COPY tsconfig-test.json /
COPY test/ /test/

WORKDIR /
RUN npm run setup-firefox
RUN npm run test

WORKDIR /app
RUN zip ../interceptor-firefox.zip -r .

WORKDIR /
RUN npm run setup-chrome

WORKDIR /app
RUN zip ../interceptor-chrome.zip -r .