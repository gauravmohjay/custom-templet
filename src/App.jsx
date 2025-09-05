// src/App.jsx (updated / debug-friendly)
import React, { useEffect, useRef, useState } from "react";
import { Room } from "livekit-client";

export default function App() {
  const [connected, setConnected] = useState(false);
  const [tiles, setTiles] = useState(new Map());
  const roomRef = useRef(null);
  const startedRef = useRef(false);
  const snapshotIntervalRef = useRef(null);

  const params = new URLSearchParams(window.location.search);
  const wsUrl = params.get("url") || params.get("wsUrl");
  const token = params.get("token") || params.get("accessToken");

  useEffect(() => {
    if (!wsUrl || !token) {
      document.body.innerHTML = `<div style='padding:24px;font-family:sans-serif;color:#b91c1c'>
        <h2>Missing parameters</h2>
        <p>Provide <code>?url=&lt;ws/wss&gt;&amp;token=&lt;recorder-token&gt;</code></p>
      </div>`;
      return;
    }

    const room = new Room({ autoSubscribe: true });
    roomRef.current = room;

    const safeAddTile = (identity, displayName = null) => {
      setTiles((prev) => {
        if (prev.has(identity)) return prev;
        const next = new Map(prev);
        next.set(identity, {
          identity,
          displayName: displayName ?? identity,
          hasVideo: false,
          hasAudio: false,
          speaking: false,
          videoEl: null,
        });
        return next;
      });
    };

    const safeRemoveTile = (identity) => {
      setTiles((prev) => {
        const next = new Map(prev);
        const p = next.get(identity);
        if (p && p.videoEl && p.videoEl.remove) {
          try { p.videoEl.remove(); } catch (e) {}
        }
        next.delete(identity);
        return next;
      });
    };

    const attachVideo = (participant, track) => {
      const identity = participant.identity || participant.sid || String(participant);
      try {
        const el = track.attach();
        el.id = `video-${identity}`;
        el.autoplay = true;
        el.playsInline = true;
        el.style.width = "100%";
        el.style.height = "100%";
        el.style.objectFit = "cover";
        setTiles((prev) => {
          const next = new Map(prev);
          const p = next.get(identity) || { identity, displayName: identity };
          p.videoEl = el;
          p.hasVideo = true;
          next.set(identity, p);
          return next;
        });
        console.log(`Template: attached video for ${identity}`);
      } catch (e) {
        console.warn("Template: failed attach video", identity, e);
      }
    };

    const noteAudioPub = (participant, pub) => {
      const identity = participant.identity || participant.sid || String(participant);
      setTiles((prev) => {
        const next = new Map(prev);
        const p = next.get(identity) || { identity, displayName: identity };
        p.hasAudio = true;
        next.set(identity, p);
        return next;
      });
    };

    const onTrackSubscribed = (track, pub, participant) => {
      console.log("Template: trackSubscribed", participant?.identity, pub?.trackSid, pub?.source, pub?.kind, "isSubscribed", pub?.isSubscribed);
      if (track.kind === "video") attachVideo(participant, track);
      if (track.kind === "audio") noteAudioPub(participant, pub);
    };

    const onTrackUnsubscribed = (track, pub, participant) => {
      console.log("Template: trackUnsubscribed", participant?.identity, pub?.trackSid);
      const identity = participant?.identity || participant?.sid || String(participant);
      if (!identity) return;
      if (track.kind === "video") {
        // detach if present
        const el = document.getElementById(`video-${identity}`);
        if (el) {
          try { track.detach(el); } catch (e) {}
          try { el.remove(); } catch (e) {}
        }
        setTiles((prev) => {
          const next = new Map(prev);
          const p = next.get(identity);
          if (p) {
            p.hasVideo = false;
            p.videoEl = null;
            next.set(identity, p);
          }
          return next;
        });
      }
      if (track.kind === "audio") {
        setTiles((prev) => {
          const next = new Map(prev);
          const p = next.get(identity);
          if (p) {
            p.hasAudio = false;
            p.speaking = false;
            next.set(identity, p);
          }
          return next;
        });
      }
    };

    const onParticipantConnected = (participant) => {
      const identity = participant.identity || participant.sid || String(participant);
      const display = participant.metadata || participant.name || identity;
      console.log("Template: participantConnected:", identity, "metadata:", participant.metadata);
      safeAddTile(identity, display);

      // log publications
      try {
        participant.tracks?.forEach?.((pub) => {
          console.log("Template: existing publication for", identity, "pub:", pub.trackSid, "source:", pub.source, "kind:", pub.kind, "isSubscribed:", pub.isSubscribed);
        });
      } catch (e) {
        console.warn("Template: could not iterate participant.tracks for", identity, e);
      }
    };

    const onParticipantDisconnected = (participant) => {
      const identity = participant.identity || participant.sid || String(participant);
      console.log("Template: participantDisconnected:", identity);
      safeRemoveTile(identity);
    };

    const doConnect = async () => {
      try {
        console.log("Template: connecting to", wsUrl);
        await room.connect(wsUrl, token, { autoSubscribe: true });
        setConnected(true);
        console.log("Template: connected as", room.localParticipant.identity, "local metadata:", room.localParticipant.metadata);

        // Add local participant tile
        safeAddTile(room.localParticipant.identity, room.localParticipant.metadata || room.localParticipant.identity);

        // Iterate remote participants safely (correct callback param)
        try {
          room.participants?.forEach?.((participant) => {
            const identity = participant.identity || participant.sid || String(participant);
            console.log("Template: existing participant:", identity, "metadata:", participant.metadata);
            safeAddTile(identity, participant.metadata || identity);

            // list their publications and try to attach already-subscribed tracks
            try {
              participant.tracks?.forEach?.((pub) => {
                console.log("Template: participant.pub:", identity, pub.trackSid, "source:", pub.source, "kind:", pub.kind, "isSubscribed:", pub.isSubscribed);
                if (pub.isSubscribed && pub.track) {
                  // attach track explicitly
                  if (pub.track.kind === "video") attachVideo(participant, pub.track);
                  if (pub.track.kind === "audio") noteAudioPub(participant, pub);
                }
              });
            } catch (e) {
              console.warn("Template: iterating participant.tracks failed for", identity, e);
            }
          });
        } catch (e) {
          console.warn("Template: room.participants iterate error", e);
        }

        // wire events after initial enumerations
        room.on("participantConnected", onParticipantConnected);
        room.on("participantDisconnected", onParticipantDisconnected);
        room.on("trackSubscribed", onTrackSubscribed);
        room.on("trackUnsubscribed", onTrackUnsubscribed);

        // log a consistent START_RECORDING once we consider the UI ready
        if (!startedRef.current) {
          startedRef.current = true;
          setTimeout(() => {
            console.log("START_RECORDING");
            console.info("Template: START_RECORDING logged.");
          }, 350);
        }

        // Periodic snapshot for debugging: list participants and publications every 5s
        snapshotIntervalRef.current = setInterval(() => {
          try {
            const snap = [];
            room.participants?.forEach?.((p) => {
              const pubs = [];
              p.tracks?.forEach?.((pub) => pubs.push({ trackSid: pub.trackSid, source: pub.source, kind: pub.kind, isSubscribed: pub.isSubscribed }));
              snap.push({ identity: p.identity, metadata: p.metadata, publications: pubs });
            });
            console.log("TEMPLATE_SNAPSHOT:", JSON.stringify(snap));
          } catch (e) {
            console.warn("Snapshot failed:", e);
          }
        }, 5000);
      } catch (err) {
        console.error("Template: failed to connect recorder room:", err);
      }
    };

    doConnect();

    const cleanup = () => {
      try {
        room.off("participantConnected", onParticipantConnected);
        room.off("participantDisconnected", onParticipantDisconnected);
        room.off("trackSubscribed", onTrackSubscribed);
        room.off("trackUnsubscribed", onTrackUnsubscribed);
      } catch (e) {}
      try { room.disconnect(); } catch (e) {}
      if (snapshotIntervalRef.current) clearInterval(snapshotIntervalRef.current);
    };

    window.addEventListener("beforeunload", () => {
      console.log("END_RECORDING");
      cleanup();
    });

    return () => {
      try { window.removeEventListener("beforeunload", () => {}); } catch (e) {}
      cleanup();
    };
  }, []);

  // render tiles
  const arr = Array.from(tiles.values());
  const cols = Math.max(1, Math.ceil(Math.sqrt(arr.length)));
  return (
    <div style={{ padding: 12, background: "#071027", height: "100vh", color: "#e6eef8", fontFamily: "Inter, Roboto, sans-serif", boxSizing: "border-box" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <div>Recording Template</div>
        <div>Connected: {String(Boolean(roomRef.current && roomRef.current.state === "connected"))} — participants: {arr.length}</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 8, height: "calc(100vh - 80px)" }}>
        {arr.map((p) => (
          <div key={p.identity} style={{ background: "#0b1220", borderRadius: 8, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", position: "relative", minHeight: 120 }}>
            {p.hasVideo && p.videoEl ? (
              <div style={{ width: "100%", height: "100%" }} ref={(node) => {
                if (!node) return;
                node.innerHTML = "";
                if (p.videoEl && p.videoEl instanceof HTMLElement) node.appendChild(p.videoEl);
              }} />
            ) : (
              <div style={{ textAlign: "center" }}>
                <div style={{ fontWeight: 700 }}>{p.displayName}</div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>{p.hasAudio ? "Audio" : "Offline"}</div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
