package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/gorilla/websocket"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "pair":
		runPair()
	case "ws":
		runWS()
	case "send":
		runSend()
	default:
		usage()
	}
}

func runPair() {
	fs := flag.NewFlagSet("pair", flag.ExitOnError)
	baseURL := fs.String("base-url", "http://localhost:28080", "routing server base URL")
	fs.Parse(os.Args[2:])

	resp, err := http.Post(*baseURL+"/api/v1/pair/request", "application/json", bytes.NewReader([]byte("{}")))
	if err != nil {
		log.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	fmt.Println(string(out))
}

func runWS() {
	fs := flag.NewFlagSet("ws", flag.ExitOnError)
	baseURL := fs.String("base-url", "http://localhost:28080", "routing server base URL")
	apiKey := fs.String("api-key", "", "bearer API key from pair request")
	fs.Parse(os.Args[2:])
	if *apiKey == "" {
		log.Fatal("missing --api-key")
	}

	u, err := toWSURL(*baseURL)
	if err != nil {
		log.Fatal(err)
	}
	u.Path = "/ws"
	header := http.Header{}
	header.Set("Authorization", "Bearer "+*apiKey)
	conn, _, err := websocket.DefaultDialer.Dial(u.String(), header)
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close()

	fmt.Println("connected. waiting for events...")
	for {
		_, msg, readErr := conn.ReadMessage()
		if readErr != nil {
			log.Fatal(readErr)
		}
		fmt.Println(string(msg))
	}
}

func runSend() {
	fs := flag.NewFlagSet("send", flag.ExitOnError)
	baseURL := fs.String("base-url", "http://localhost:28080", "routing server base URL")
	apiKey := fs.String("api-key", "", "bearer API key from pair request")
	to := fs.String("to", "+10000000000", "target phone number")
	text := fs.String("text", "hello from devcli", "message text")
	fs.Parse(os.Args[2:])
	if *apiKey == "" {
		log.Fatal("missing --api-key")
	}

	body := map[string]string{
		"toPhoneNumber": *to,
		"text":          *text,
	}
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, *baseURL+"/api/v1/send", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+*apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	fmt.Println(string(out))
}

func toWSURL(base string) (*url.URL, error) {
	parsed, err := url.Parse(base)
	if err != nil {
		return nil, err
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http":
		parsed.Scheme = "ws"
	case "https":
		parsed.Scheme = "wss"
	default:
		return nil, fmt.Errorf("unsupported scheme: %s", parsed.Scheme)
	}
	return parsed, nil
}

func usage() {
	fmt.Println("usage: devcli <pair|ws|send> [flags]")
	os.Exit(1)
}
