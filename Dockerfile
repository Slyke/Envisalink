FROM node:22

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

RUN useradd -m buttonwui
RUN mkdir -p /data && chown -R buttonwui:buttonwui /data /app

USER buttonwui

ENV NODE_ENV=production
EXPOSE 8192
CMD ["node", "src/index.js"]
