# The renderer drives headless Chromium with software WebGL, so the image has to
# carry the browser + its system libs. Playwright's image already does.
# It lags the npm package (no stable v1.62.0 image yet), so the system deps come
# from here and the exact Chromium build for package-lock's playwright is pulled
# in below — they don't have to match.
FROM mcr.microsoft.com/playwright:v1.61.1-noble

ENV NODE_ENV=production \
    PORT=10000 \
    RUNS_DIR=/var/data/runs

WORKDIR /app

# deps first: code-only deploys reuse these layers
COPY package.json package-lock.json ./
RUN npm ci && npx playwright install chromium

COPY . .

EXPOSE 10000
CMD ["node", "src/server.js"]
