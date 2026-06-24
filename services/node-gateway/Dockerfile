# Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
FROM node:20-slim

WORKDIR /app

# Enable pnpm through corepack, pinned for reproducible builds.
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY package.json ./
RUN pnpm install --prod

COPY src ./src

USER node
EXPOSE 4000
CMD ["node", "src/index.js"]
