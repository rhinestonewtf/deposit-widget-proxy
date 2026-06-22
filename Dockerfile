FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src/ src/
RUN bun build --compile --minify --target=bun src/index.ts --outfile /server

FROM gcr.io/distroless/base-debian12:nonroot
COPY --from=build /server /server
ENTRYPOINT ["/server"]
