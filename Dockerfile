# syntax=docker/dockerfile:1

# Node 22 is used to install the production workspace dependencies. The digest
# pins the verified bookworm-slim image from Docker Hub.
FROM node:22.12.0-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213 AS build

WORKDIR /app

# .dockerignore excludes .env files, keys, local data, dependencies, and build
# output, so no secrets or local databases enter this layer.
COPY . .

RUN npm ci --workspace=server --omit=dev

# Python 3.12 is the runtime base so all Python stdlib shared libraries remain
# intact. The digest pins the verified bookworm-slim image from Docker Hub.
FROM python:3.12.10-slim-bookworm@sha256:fd95fa221297a88e1cf49c55ec1828edd7c5a428187e67b5d1805692d11588db AS runtime

# Copy the pinned Node 22 binaries from the build stage into the Python base.
# Both stages use Debian bookworm, so their glibc/ABI are compatible.
COPY --from=build /usr/local/bin /usr/local/bin
COPY --from=build /usr/local/lib/node_modules /usr/local/lib/node_modules

WORKDIR /app
COPY --from=build /app /app

ENV PYTHON_BIN=/usr/local/bin/python3.12

# Fail the image build early if either runtime is missing or too old.
RUN node --version \
 && npm --version \
 && test -x /usr/local/bin/python3.12 \
 && /usr/local/bin/python3.12 -c 'import sys; assert sys.version_info >= (3, 12), sys.version' \
 && /usr/local/bin/python3.12 --version

# Same startup process as the existing Render native Node service.
CMD ["npm", "run", "start", "--workspace=server"]
