FROM node:20-alpine AS build

WORKDIR /app

COPY package.json tsconfig.json ./
COPY data/sfuncman.json ./reference/sfuncman.json
COPY media ./media
COPY mcp ./mcp
COPY ui ./ui
COPY scripts ./scripts

RUN npm install
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime

RUN apk add --no-cache openssl

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3333
ENV MICROS_FUNCTION_MANUAL_PATH=/app/reference/sfuncman.json

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/reference ./reference
COPY --from=build /app/media ./media
COPY --from=build /app/ui ./ui
COPY --from=build /app/scripts ./scripts

RUN mkdir -p data

EXPOSE 3333

ENTRYPOINT ["node", "scripts/start.mjs"]
CMD ["mcp"]
