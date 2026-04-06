FROM node:20-slim

# Install Chromium and Hebrew/emoji fonts
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-noto-color-emoji \
    fonts-noto-cjk \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Ensure runtime directories exist
RUN mkdir -p data credentials .wwebjs_auth

EXPOSE 3000

CMD ["node", "src/server.js"]
