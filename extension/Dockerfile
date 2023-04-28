FROM node:18.16.0-alpine3.17@sha256:44aaf1ccc80eaed6572a0f2ef7d6b5a2982d54481e4255480041ac92221e2f11

RUN apk --no-cache add zip

COPY ./build/package.json /extension/build/package.json
COPY ./build/package-lock.json /extension/build/package-lock.json
WORKDIR /extension/build
RUN npm ci

COPY ./package.json /extension/package.json
COPY ./package-lock.json /extension/package-lock.json
WORKDIR /extension
RUN npm ci

COPY tsconfig.json tsconfig-inpage.json tsconfig-inpage-output.json tsconfig-inpage-create-injection-script.json /extension/
COPY app/*.png app/*.jpg app/*.json app/*.ico /extension/app/
COPY app/html/ /extension/app/html/
COPY app/html3/ /extension/app/html3/
COPY app/css/ /extension/app/css/
COPY app/ts/ /extension/app/ts/
COPY app/img/ /extension/app/img/
COPY app/inpage/ /extension/app/inpage/
COPY build/tsconfig.json build/vendor.mts build/bundler.mts /extension/build/

COPY tsconfig-test.json /extension/
COPY test/ /extension/test/

WORKDIR /extension
RUN npm run setup-firefox
RUN npm run test

WORKDIR /extension/app
RUN zip ../interceptor-firefox.zip -r .

WORKDIR /extension
RUN npm run setup-chrome

WORKDIR /extension/app
RUN zip ../interceptor-chrome.zip -r .
