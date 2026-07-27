// Copyright 2025 Element Creations Ltd.
// Copyright 2023 - 2025 New Vector Ltd.
//
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"io"
	"log"
	"log/slog"
	"net/http"
	"os"
	"strings"

	"github.com/SladkyCitron/slogcolor"
	"github.com/livekit/protocol/auth"
	"github.com/mattn/go-isatty"
)

func configureLogging(logLevelString string, writer io.Writer) {
	if strings.EqualFold(logLevelString, "off") {
		slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
		log.SetOutput(io.Discard)
		return
	}

	opts := slogcolor.DefaultOptions
	opts.NoColor = !isatty.IsTerminal(os.Stderr.Fd())

	switch strings.ToLower(logLevelString) {
	case "debug":
		opts.Level = slog.LevelDebug
	case "info":
	case "warn", "warning":
		opts.Level = slog.LevelWarn
	case "error":
		opts.Level = slog.LevelError
	case "":
		opts.Level = slog.LevelInfo
		slog.Info("log level defaulting to info")
	default:
		opts.Level = slog.LevelInfo
		slog.Warn(
			"Invalid log level in LIVEKIT_LOG_LEVEL, defaulting to info",
			"invalidValue",
			logLevelString,
		)
	}
	slog.SetDefault(slog.New(slogcolor.NewHandler(writer, opts)))
	log.SetOutput(writer)
}

func main() {
	configureLogging(os.Getenv("LIVEKIT_LOG_LEVEL"), os.Stderr)

	config, err := parseConfig()
	if err != nil {
		log.Fatal(err)
	}

	var store store
	if config.RedisURL != "" {
		store, err = newRedisStore(config.RedisURL)
		if err != nil {
			log.Fatalf("Could not connect Redis store: %v", err)
		}
	} else {
		slog.Warn("LIVEKIT_REDIS_URL not set. Using in-memory store.")
		store = nil
	}

	handler := NewHandler(
		LiveKitAuth{
			key:          config.Key,
			secret:       config.Secret,
			authProvider: auth.NewSimpleKeyProvider(config.Key, config.Secret),
			lkUrl:        config.LkUrl,
		},
		config.SkipVerifyTLS,
		config.FullAccessHomeservers,
		config.SanityCheckInterval,
		config.CsApiUrlOverrides,
		store,
	)

	sanityCheckIntervalDisplay := "disabled"
	if config.SanityCheckInterval > 0 {
		sanityCheckIntervalDisplay = config.SanityCheckInterval.String()
	}
	slog.Info(
		"Starting service",
		"LIVEKIT_URL",
		config.LkUrl,
		"LIVEKIT_JWT_BIND",
		config.LkJwtBind,
		"LIVEKIT_FULL_ACCESS_HOMESERVERS",
		config.FullAccessHomeservers,
		"SkipVerifyTLS",
		config.SkipVerifyTLS,
		"SanityCheckInterval",
		sanityCheckIntervalDisplay,
	)

	log.Fatal(http.ListenAndServe(config.LkJwtBind, handler.prepareMux()))
}
