# Use official Node.js image with Alpine (smaller size)
FROM node:20-alpine

# Install Chrome and PostgreSQL client dependencies for Puppeteer
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    postgresql-client

# Set Puppeteer config to use installed Chrome
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV CHROME_PATH=/usr/bin/chromium-browser
ENV NODE_ENV=production

# Create and set working directory
WORKDIR /app

# Create a non-root user and switch to it
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

# Copy package files first for better layer caching
COPY --chown=appuser:appgroup package*.json ./

# Install dependencies
RUN npm install --production

# Copy application files
COPY --chown=appuser:appgroup . .

# Health check
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD node -e "require('pg').Pool().query('SELECT 1')"

# Run the application
CMD ["node", "main.js"]
