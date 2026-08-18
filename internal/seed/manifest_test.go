package seed

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestEmbeddedManifestMatchesReleaseLock(t *testing.T) {
	embedded, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join("..", "..", "release", "seed.lock.json"))
	if err != nil {
		t.Fatal(err)
	}
	var release Manifest
	if err := json.Unmarshal(b, &release); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(embedded, release) {
		t.Fatalf("embedded seed lock drifted from release lock: %#v != %#v", embedded, release)
	}
}
