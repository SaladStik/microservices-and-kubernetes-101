# Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
FROM node:20-slim

WORKDIR /app

# enable pnpm, pinned for reproducible builds
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# deps first for layer caching
COPY package.json ./
RUN pnpm install --prod

COPY src ./src

USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
