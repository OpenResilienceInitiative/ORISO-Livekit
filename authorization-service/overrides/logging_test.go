// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"log"
	"log/slog"
	"testing"
)

func TestConfigureLoggingOffDiscardsStructuredAndStandardLogs(t *testing.T) {
	var output bytes.Buffer

	configureLogging("off", &output)
	slog.Error("authorization failed", "openid_token", "sensitive-token")
	log.Print("sensitive-user-and-room")

	if output.Len() != 0 {
		t.Fatalf("off logging emitted sensitive output: %q", output.String())
	}
}
