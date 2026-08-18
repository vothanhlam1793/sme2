# https://docs.docker.com/samples/library/node/
ARG NODE_VERSION=16.13.1

# https://github.com/Yelp/dumb-init/releases
ARG DUMB_INIT_VERSION=1.2.2

# Build container
FROM node:${NODE_VERSION}-alpine AS build
ARG DUMB_INIT_VERSION

WORKDIR /home/node

RUN apk add --no-cache build-base python2 yarn && \
    wget -O dumb-init -q https://github.com/Yelp/dumb-init/releases/download/v${DUMB_INIT_VERSION}/dumb-init_${DUMB_INIT_VERSION}_amd64 && \
    chmod +x dumb-init
ADD ./package.json ./package.json
ADD ./yarn.lock ./yarn.lock

RUN yarn install 

ADD . /home/node

RUN NODE_ENV=production ./node_modules/.bin/keystone build && yarn cache clean

# Runtime container
FROM node:${NODE_VERSION}-alpine

WORKDIR /home/node

COPY --from=build /home/node /home/node

EXPOSE 3000
ENV NODE_ENV=production
CMD ["./dumb-init", "node", "./node_modules/.bin/keystone", "start"]