FROM node:24.14.0-bookworm-slim

RUN npm install --global pnpm@11.15.1
WORKDIR /workspace
