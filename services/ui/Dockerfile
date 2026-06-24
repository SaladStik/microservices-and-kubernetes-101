# Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
# Multi stage build, Vite builds static files then nginx serves them.

# build stage
FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY package.json ./
RUN pnpm install            # needs devDeps like vite to build
COPY . .
RUN pnpm build

# serve stage
FROM nginx:1.27-alpine
COPY default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
