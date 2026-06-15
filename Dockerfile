FROM node:20-slim
WORKDIR /app
COPY . .
ENV PORT=8137
EXPOSE 8137
CMD ["node","server.mjs"]
