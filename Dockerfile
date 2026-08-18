ARG NODE_VERSION=16.13.1

FROM node:${NODE_VERSION}-alpine AS build

WORKDIR /home/node

RUN apk add --no-cache build-base python2

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .

RUN NODE_ENV=production \
    KEYSTONE_BUILD=true \
    COOKIE_SECRET=build-only \
    yarn keystone build && yarn cache clean

FROM node:${NODE_VERSION}-alpine

WORKDIR /home/node

RUN apk add --no-cache dumb-init

COPY --from=build --chown=node:node /home/node ./

EXPOSE 3000
ENV NODE_ENV=production

USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["./node_modules/.bin/keystone", "start"]
