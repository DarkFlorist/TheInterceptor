# syntax=docker/dockerfile:1.4

FROM node:18-alpine@sha256:9036ddb8252ba7089c2c83eb2b0dcaf74ff1069e8ddf86fe2bd6dc5fecc9492d

RUN apk add --no-cache zip

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


LABEL org.label-schema.build-date=$BUILD_DATE \
      org.label-schema.name="The Interceptor Browser Extenstion" \
      org.label-schema.description="TheInterceptor" \
      org.label-schema.url="https://dark.florist/" \
      org.label-schema.vcs-ref=$VCS_REF \
      org.label-schema.vcs-url="https://github.com/DarkFlorist/TheInterceptor.git" \
      org.label-schema.vendor="Dark Florist" \
      org.label-schema.version=$VERSION \
      org.label-schema.schema-version="1.0"
