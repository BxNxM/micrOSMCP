FROM node:20-alpine AS build

WORKDIR /app

COPY package.json tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY data ./data

RUN npm install
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3333

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/data ./data

EXPOSE 3333

ENTRYPOINT ["node", "scripts/start.mjs"]
CMD ["mcp"]
