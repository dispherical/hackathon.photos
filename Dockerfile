FROM node:20-bookworm

RUN apt-get update && apt-get install -y \
  libstdc++6 \
  unzip \
  curl \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.com/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

COPY package.json bun.lockb* package-lock.json* ./

RUN bun install
COPY . .
EXPOSE 80

CMD ["bun", "run", "start"]
