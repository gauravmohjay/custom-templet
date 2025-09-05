// src/App.jsx
import React, { useEffect, useRef, useState } from "react";
import { Room } from "livekit-client";

export default function App() {
  const [tiles, setTiles] = useState(new Map());
  const roomRef = useRef(null);
  const startedRef = useRef(false);
  const snapshotIntervalRef = useRef(null);

  // Egress passes ?url=...&token=... (or ?wsUrl & accessToken)
  const params = new URLSearchParams(window.location.search);
  const wsUrl = params.get("url") || params.get("wsUrl");
  const token = params.get("token") || params.get("accessToken");

  useEffect(() => {
    if (!wsUrl || !token) {
      // show an error on the page if token/url missing
      document.body.innerHTML = `<div style='padding:20px;font-family:sans-serif;color:#111'>
        <h2>Missing parameters</h2>
        <p>Open this page with <code>?url=&lt;ws/wss url&gt;&amp;token=&lt;recorder-token&gt;</code></p>
      </div>`;
      return;
    }

    const room = new Room({ autoSubscribe: true });
    roomRef.current = room;

    const addPlaceholder = (identity, displayName = null) => {
      setTiles((prev) => {
        if (prev.has(identity)) return prev;
        const next = new Map(prev);
        next.set(identity, {
          identity,
          displayName: displayName || identity,
          hasVideo: false,
          hasAudio: false,
          videoEl: null,
          analyser: null,
          speaking: false,
        });
        return next;
      });
    };

    const removeTile = (identity) => {
      setTiles((prev) => {
        const next = new Map(prev);
        const p = next.get(identity);
        if (p?.videoEl && p.videoEl.parentNode) {
          p.videoEl.remove();
        }
        next.delete(identity);
        return next;
      });
    };

    const attachVideo = (participant, track) => {
      const id = participant.identity;
      const el = track.attach();
      el.id = `video-${id}`;
      el.autoplay = true;
      el.playsInline = true;
      el.style.width = "100%";
      el.style.height = "100%";
      el.style.objectFit = "cover";

      setTiles((prev) => {
        const next = new Map(prev);
        const p = next.get(id) || { identity: id, displayName: id };
        p.hasVideo = true;
        p.videoEl = el;
        next.set(id, p);
        return next;
      });
    };

    const attachAudio = (participant, track) => {
      const id = participant.identity;
      const el = track.attach();
      el.muted = true; // recorder's page should not echo audio
      el.play().catch(() => {});

      // create AudioContext analyser for speaking detection
      try {
        const ctx = new window.AudioContext();
        const stream = new MediaStream([track.mediaStreamTrack]);
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);

        setTiles((prev) => {
          const next = new Map(prev);
          const p = next.get(id) || { identity: id, displayName: id };
          p.hasAudio = true;
          p.analyser = analyser;
          next.set(id, p);
          return next;
        });
      } catch (e) {
        // AudioContext may fail in some headless contexts - still proceed.
        setTiles((prev) => {
          const next = new Map(prev);
          const p = next.get(id) || { identity: id, displayName: id };
          p.hasAudio = true;
          next.set(id, p);
          return next;
        });
      }
    };

    const detachTrack = (track, pub, participant) => {
      const id = participant.identity;
      if (track.kind === "video") {
        setTiles((prev) => {
          const next = new Map(prev);
          const p = next.get(id);
          if (p) {
            p.hasVideo = false;
            if (p.videoEl && p.videoEl.parentNode) {
              p.videoEl.remove();
            }
            p.videoEl = null;
            next.set(id, p);
          }
          return next;
        });
      }
      if (track.kind === "audio") {
        setTiles((prev) => {
          const next = new Map(prev);
          const p = next.get(id);
          if (p) {
            p.hasAudio = false;
            p.analyser = null;
            next.set(id, p);
          }
          return next;
        });
      }
    };

    // Events
    const onParticipantConnected = (participant) => {
      addPlaceholder(participant.identity, participant.metadata || participant.identity);
      console.log("TEMPLATE: participantConnected", participant.identity);
    };
    const onParticipantDisconnected = (participant) => {
      removeTile(participant.identity);
      console.log("TEMPLATE: participantDisconnected", participant.identity);
    };

    const onTrackSubscribed = (track, publication, participant) => {
      console.log("TEMPLATE: trackSubscribed", participant.identity, publication.source, track.kind);
      if (track.kind === "video") attachVideo(participant, track);
      if (track.kind === "audio") attachAudio(participant, track);
    };

    const onTrackUnsubscribed = (track, publication, participant) => {
      console.log("TEMPLATE: trackUnsubscribed", participant.identity, publication.source, track.kind);
      detachTrack(track, publication, participant);
    };

    const connectAndBootstrap = async () => {
      try {
        console.log("TEMPLATE: connecting to", wsUrl);
        await room.connect(wsUrl, token, { autoSubscribe: true });

        // Add placeholders for all participants (local + existing remotes)
        addPlaceholder(room.localParticipant.identity, room.localParticipant.metadata || room.localParticipant.identity);
        room.participants.forEach((p) => addPlaceholder(p.identity, p.metadata || p.identity)); // correct Map.forEach(value,key)

        // Attach already-subscribed tracks (if any)
        room.participants.forEach((p) => {
          p.tracks.forEach((pub) => {
            if (pub.isSubscribed && pub.track) {
              if (pub.track.kind === "video") attachVideo(p, pub.track);
              if (pub.track.kind === "audio") attachAudio(p, pub.track);
            }
          });
        });

        // Wire events
        room.on("participantConnected", onParticipantConnected);
        room.on("participantDisconnected", onParticipantDisconnected);
        room.on("trackSubscribed", onTrackSubscribed);
        room.on("trackUnsubscribed", onTrackUnsubscribed);

        // Wait a short stabilization window (allow subscriptions to settle), then signal START_RECORDING
        if (!startedRef.current) {
          startedRef.current = true;
          setTimeout(() => {
            console.log("START_RECORDING"); // this is required by egress to proceed
          }, 800); // 800ms hysteresis gives time for subscriptions (adjust if needed)
        }

        // Periodic snapshot for egress debugging (check docker logs)
        snapshotIntervalRef.current = setInterval(() => {
          const snap = [];
          room.participants.forEach((p) => {
            const pubs = [];
            p.tracks.forEach((pub) => pubs.push({
              sid: pub.trackSid,
              kind: pub.kind,
              isSubscribed: pub.isSubscribed,
              source: pub.source
            }));
            snap.push({ identity: p.identity, metadata: p.metadata, publications: pubs });
          });
          console.log("TEMPLATE_SNAPSHOT:", JSON.stringify(snap));
        }, 4000);
      } catch (err) {
        console.error("TEMPLATE: connect failed", err);
      }
    };

    connectAndBootstrap();

    return () => {
      if (snapshotIntervalRef.current) clearInterval(snapshotIntervalRef.current);
      if (roomRef.current) roomRef.current.disconnect();
    };
  }, []);

  // speaking detection updater
  useEffect(() => {
    const id = setInterval(() => {
      setTiles((prev) => {
        const next = new Map(prev);
        next.forEach((p) => {
          if (p.analyser) {
            const buf = new Uint8Array(p.analyser.frequencyBinCount);
            p.analyser.getByteFrequencyData(buf);
            const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
            p.speaking = avg > 20;
          }
        });
        return new Map(next);
      });
    }, 250);
    return () => clearInterval(id);
  }, []);

  const arr = Array.from(tiles.values());
  const cols = Math.max(1, Math.ceil(Math.sqrt(arr.length)));

  return (
    <div style={{ padding: 12, background: "#071027", minHeight: "100vh", color: "#e6eef8", fontFamily: "Inter, Roboto, sans-serif" }}>
      <div style={{ marginBottom: 8 }}>Participants: {arr.length}</div>

      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 8 }}>
        {arr.map((p) => (
          <div key={p.identity} style={{ position: "relative", minHeight: 120, borderRadius: 8, overflow: "hidden", background: "#0b1220", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {p.hasVideo && p.videoEl ? (
              <div style={{ width: "100%", height: 200 }} ref={(node) => {
                if (!node) return;
                node.innerHTML = "";
                if (p.videoEl) node.appendChild(p.videoEl);
              }} />
            ) : (
              <div style={{ textAlign: "center", padding: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 18 }}>{p.displayName}</div>
                <div style={{ opacity: 0.8, fontSize: 12 }}>{p.hasAudio ? "Audio only" : "No media"}</div>
              </div>
            )}

            {p.speaking && <div style={{ position: "absolute", top: 6, right: 6, width: 10, height: 10, borderRadius: "50%", background: "#22c55e", animation: "blink 1s infinite" }} />}
          </div>
        ))}
      </div>

      <style>{`
        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}
