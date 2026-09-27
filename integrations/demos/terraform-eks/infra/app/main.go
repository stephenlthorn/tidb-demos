package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync/atomic"

	_ "github.com/go-sql-driver/mysql"
)

var (
	queryCount int64
	errorCount int64
	db         *sql.DB
	connTarget string
)

func main() {
	host := os.Getenv("TIDB_HOST")
	port := os.Getenv("TIDB_PORT")
	user := os.Getenv("TIDB_USER")
	password := os.Getenv("TIDB_PASSWORD")
	connTarget = host

	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/test?tls=preferred", user, password, host, port)
	var err error
	db, err = sql.Open("mysql", dsn)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	db.SetMaxOpenConns(20)

	http.HandleFunc("/work", func(w http.ResponseWriter, r *http.Request) {
		var one int
		if err := db.QueryRow("SELECT 1").Scan(&one); err != nil {
			atomic.AddInt64(&errorCount, 1)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		atomic.AddInt64(&queryCount, 1)
		w.WriteHeader(http.StatusOK)
	})

	http.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "tidb_connection_target{host=%q} 1\n", connTarget)
		fmt.Fprintf(w, "app_query_count %d\n", atomic.LoadInt64(&queryCount))
		fmt.Fprintf(w, "app_error_count %d\n", atomic.LoadInt64(&errorCount))
	})

	http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	log.Print("listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}
