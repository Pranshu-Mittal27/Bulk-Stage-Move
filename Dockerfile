FROM node:22.23.4-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY . .

RUN chmod +x scripts/run-compose-tests.sh

ENTRYPOINT ["sh", "scripts/run-compose-tests.sh"]
