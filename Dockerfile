FROM node:24-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.cjs ./
USER node
EXPOSE 8080
CMD ["node", "server.cjs"]
