FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod main.go ./
RUN go mod tidy && go build -o /app main.go

FROM gcr.io/distroless/base-debian12
COPY --from=build /app /app
EXPOSE 8080
ENTRYPOINT ["/app"]
