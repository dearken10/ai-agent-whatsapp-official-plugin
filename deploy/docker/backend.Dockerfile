FROM golang:1.25-alpine AS builder
WORKDIR /app
COPY backend/go.mod backend/go.sum* ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /bin/wa-server ./cmd/server

FROM alpine:3.20
RUN adduser -D app
USER app
WORKDIR /home/app
COPY --from=builder /bin/wa-server /usr/local/bin/wa-server
EXPOSE 8080
ENTRYPOINT ["wa-server"]
