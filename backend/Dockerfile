FROM golang:1.24-alpine AS builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o woodshop-security .

FROM alpine:3.19
RUN apk add --no-cache ffmpeg ca-certificates
WORKDIR /app
COPY --from=builder /build/woodshop-security .
EXPOSE 8080
CMD ["./woodshop-security"]
