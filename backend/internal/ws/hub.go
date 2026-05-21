package ws

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type Envelope struct {
	Type      string      `json:"type"`
	Payload   interface{} `json:"payload"`
	Timestamp string      `json:"timestamp"`
	MessageID string      `json:"message_id"`
}

type Hub struct {
	mu          sync.RWMutex
	connections map[string]*websocket.Conn
}

func NewHub() *Hub {
	return &Hub{
		connections: map[string]*websocket.Conn{},
	}
}

func (h *Hub) Register(instanceID string, conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if old := h.connections[instanceID]; old != nil {
		_ = old.Close()
	}
	h.connections[instanceID] = conn
}

// Remove removes instanceID from the hub only if the stored connection is conn.
// This prevents a reconnecting client's new connection from being unregistered
// by the deferred cleanup of the previous goroutine.
func (h *Hub) Remove(instanceID string, conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.connections[instanceID] == conn {
		delete(h.connections, instanceID)
	}
}

func (h *Hub) Send(instanceID string, eventType string, messageID string, payload interface{}) bool {
	h.mu.RLock()
	conn := h.connections[instanceID]
	h.mu.RUnlock()
	if conn == nil {
		return false
	}
	msg := Envelope{
		Type:      eventType,
		Payload:   payload,
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		MessageID: messageID,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return false
	}
	if err = conn.WriteMessage(websocket.TextMessage, data); err != nil {
		return false
	}
	return true
}
