package main

import (
	"reflect"
	"testing"

	"github.com/livekit/protocol/auth"
)

func TestJoinTokenRestrictsPublishedTrackSources(t *testing.T) {
	token, err := getJoinToken(
		"testKey",
		"testSecret",
		LiveKitRoomAlias("testRoom"),
		LiveKitIdentity("testIdentity"),
		[]string{"microphone"},
	)
	if err != nil {
		t.Fatalf("getJoinToken returned an error: %v", err)
	}

	verifier, err := auth.ParseAPIToken(token)
	if err != nil {
		t.Fatalf("could not parse token: %v", err)
	}
	_, grants, err := verifier.Verify("testSecret")
	if err != nil {
		t.Fatalf("could not verify token: %v", err)
	}

	want := []string{"microphone"}
	if !reflect.DeepEqual(grants.Video.CanPublishSources, want) {
		t.Fatalf(
			"CanPublishSources = %v, want %v",
			grants.Video.CanPublishSources,
			want,
		)
	}
}
