import React, { useEffect, useRef, useState } from "react";
import { Room } from "livekit-client";

export default function App() {
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
          analyser: null,
        });
        return next;
      });
    };

    const safeRemoveTile = (identity) => {
      setTiles((prev) => {
        const next = new Map(prev);
        next.delete(identity);
        return next;
      });
    };

    const attachVideo = (participant, track) => {
      const identity = participant.identity;
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
    };

    const attachAudio = (participant, track) => {
      const identity = participant.identity;
      const el = track.attach();
      el.muted = true; // don’t echo in recorder
      el.play().catch(() => {});
      document.body.appendChild(el);

      // audio analyser for speaking detection
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
      const analyser = ctx.createAnalyser();
      source.connect(analyser);

      setTiles((prev) => {
        const next = new Map(prev);
        const p = next.get(identity) || { identity, displayName: identity };
        p.hasAudio = true;
        p.analyser = analyser;
        next.set(identity, p);
        return next;
      });
    };

    const onTrackSubscribed = (track, pub, participant) => {
      console.log("Template: trackSubscribed", participant.identity, pub.source, pub.kind);
      if (track.kind === "video") attachVideo(participant, track);
      if (track.kind === "audio") attachAudio(participant, track);
    };

    const onTrackUnsubscribed = (track, pub, participant) => {
      console.log("Template: trackUnsubscribed", participant.identity, pub.source, pub.kind);
      const identity = participant.identity;
      if (track.kind === "video") {
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
            p.analyser = null;
            next.set(identity, p);
          }
          return next;
        });
      }
    };

    const onParticipantConnected = (participant) => {
      const identity = participant.identity;
      const display = participant.metadata || identity;
      console.log("Template: participantConnected", identity, "metadata:", participant.metadata);
      safeAddTile(identity, display);
    };

    const onParticipantDisconnected = (participant) => {
      const identity = participant.identity;
      console.log("Template: participantDisconnected", identity);
      safeRemoveTile(identity);
    };

    const doConnect = async () => {
      try {
        console.log("Template: connecting to", wsUrl);
        await room.connect(wsUrl, token, { autoSubscribe: true });

        // Add local + existing participants
        safeAddTile(room.localParticipant.identity, room.localParticipant.metadata);
        room.participants?.forEach?.((p) => {
          safeAddTile(p.identity, p.metadata);
        });

        // Wire events
        room.on("participantConnected", onParticipantConnected);
        room.on("participantDisconnected", onParticipantDisconnected);
        room.on("trackSubscribed", onTrackSubscribed);
        room.on("trackUnsubscribed", onTrackUnsubscribed);

        // Log START_RECORDING so egress starts
        if (!startedRef.current) {
          startedRef.current = true;
          setTimeout(() => {
            console.log("START_RECORDING");
          }, 300);
        }

        // Periodic snapshot for debugging
        snapshotIntervalRef.current = setInterval(() => {
          const snap = [];
          room.participants?.forEach?.((p) => {
            const pubs = [];
            p.tracks?.forEach?.((pub) =>
              pubs.push({
                trackSid: pub.trackSid,
                source: pub.source,
                kind: pub.kind,
                isSubscribed: pub.isSubscribed,
              })
            );
            snap.push({ identity: p.identity, metadata: p.metadata, publications: pubs });
          });
          console.log("TEMPLATE_SNAPSHOT:", JSON.stringify(snap));
        }, 5000);
      } catch (err) {
        console.error("Template: failed to connect", err);
      }
    };

    doConnect();

    return () => {
      room.disconnect();
      if (snapshotIntervalRef.current) clearInterval(snapshotIntervalRef.current);
    };
  }, []);

  // compute grid
  const arr = Array.from(tiles.values());
  const cols = Math.max(1, Math.ceil(Math.sqrt(arr.length)));

  // update speaking status
  useEffect(() => {
    const id = setInterval(() => {
      setTiles((prev) => {
        const next = new Map(prev);
        next.forEach((p) => {
          if (p.analyser) {
            const buf = new Uint8Array(p.analyser.frequencyBinCount);
            p.analyser.getByteFrequencyData(buf);
            const avg = buf.reduce((a, v) => a + v, 0) / buf.length;
            p.speaking = avg > 20; // threshold
          }
        });
        return new Map(next);
      });
    }, 300);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{ padding: 12, background: "#071027", height: "100vh", color: "#e6eef8", fontFamily: "Inter, Roboto, sans-serif" }}>
      <div style={{ marginBottom: 8 }}>Participants: {arr.length}</div>

      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 8, height: "calc(100vh - 60px)" }}>
        {arr.map((p) => (
          <div key={p.identity} style={{ background: "#0b1220", borderRadius: 8, position: "relative", minHeight: 120, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {p.hasVideo && p.videoEl ? (
              <div style={{ width: "100%", height: "100%" }} ref={(node) => {
                if (!node) return;
                node.innerHTML = "";
                if (p.videoEl) node.appendChild(p.videoEl);
              }} />
            ) : (
              <div style={{ textAlign: "center" }}>
                <div style={{ fontWeight: 700 }}>{p.displayName}</div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>{p.hasAudio ? "Audio only" : "Offline"}</div>
              </div>
            )}
            {p.speaking && (
              <div style={{ position: "absolute", top: 4, right: 4, width: 10, height: 10, borderRadius: "50%", background: "#22c55e", animation: "blink 1s infinite" }} />
            )}
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
