FROM node:22-alpine

WORKDIR /app
COPY ./precompiled/ /app/
COPY ./THIRD_PARTY_NOTICES.md /app/
COPY ./*.crt /app/
COPY ./*.key /app/

ENV SIGN_CERT=/app/server.crt
ENV SIGN_KEY=/app/server.key
ENV NODE_ENV=production

EXPOSE 8080 8081
ENTRYPOINT ["node", "app.js"]
CMD ["-p", "8080:8081"]
