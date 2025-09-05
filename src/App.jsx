// src/App.jsx
import React, { useEffect, useRef, useState } from "react";
import { Room } from "livekit-client";

/**
 * Egress Recorder Template
 * - Expects query params: ?url=<ws/wss>&token=<recorder-token>
 * - Logs "START_RECORDING" after connect + short delay
 * - Logs "END_RECORDING" on unload
 */

export default function App() {
  const [connected, setConnected] = useState(false);
  const [participants, setParticipants] = useState(new Map());
  const roomRef = useRef(null);
  const startedRef = useRef(false);
  const rafs = useRef(new Map());
  const audioCtxs = useRef(new Map());

  const params = new URLSearchParams(window.location.search);
  const wsUrl = params.get("url") || params.get("wsUrl");
  const token = params.get("token") || params.get("accessToken");

  useEffect(() => {
    if (!wsUrl || !token) {
      document.body.innerHTML = `<div style="padding:24px;font-family:sans-serif;color:#b91c1c">
        <h2>Missing parameters</h2>
        <p>Provide <code>?url=&lt;ws/wss&gt;&amp;token=&lt;recorder-token&gt;</code></p>
      </div>`;
      return;
    }

    const room = new Room({ autoSubscribe: true });
    roomRef.current = room;

    const safeAddParticipant = (p) => {
      if (!p) return;
      const identity = p.identity || p.sid || String(p);
      setParticipants((prev) => {
        if (prev.has(identity)) return prev;
        const next = new Map(prev);
        next.set(identity, {
          identity,
          displayName: identity,
          hasVideo: false,
          hasAudio: false,
          speaking: false,
          videoEl: null,
        });
        return next;
      });
    };

    const safeRemoveParticipant = (p) => {
      if (!p) return;
      const identity = p.identity || p.sid || String(p);
      setParticipants((prev) => {
        const next = new Map(prev);
        const existing = next.get(identity);
        if (existing && existing.videoEl && existing.videoEl.remove) {
          try { existing.videoEl.remove(); } catch (e) {}
        }
        next.delete(identity);

        // cleanup audioContext + raf
        const ac = audioCtxs.current.get(identity);
        if (ac) { try { ac.close(); } catch (e) {} audioCtxs.current.delete(identity); }
        const r = rafs.current.get(identity);
        if (r) cancelAnimationFrame(r);
        rafs.current.delete(identity);

        return next;
      });
    };

    const attachOrUpdateTrack = (participant, track) => {
      if (!participant || !track) return;
      const identity = participant.identity || participant.sid || String(participant);

      if (track.kind === "video") {
        try {
          const el = track.attach();
          el.id = `video-${identity}`;
          el.autoplay = true;
          el.playsInline = true;
          el.style.width = "100%";
          el.style.height = "100%";
          el.style.objectFit = "cover";

          setParticipants((prev) => {
            const next = new Map(prev);
            const p = next.get(identity) || {
              identity,
              displayName: identity,
            };
            p.videoEl = el;
            p.hasVideo = true;
            next.set(identity, p);
            return next;
          });
        } catch (e) {
          console.warn("video attach failed", identity, e);
        }
      } else if (track.kind === "audio") {
        setParticipants((prev) => {
          const next = new Map(prev);
          const p = next.get(identity) || { identity, displayName: identity };
          p.hasAudio = true;
          next.set(identity, p);
          return next;
        });

        // Try to set up analyzer (best-effort). Defensive code: don't let this fail start.
        try {
          const msTrack = track.mediaStreamTrack || (track.track && track.track.mediaStreamTrack);
          let stream = null;
          if (msTrack) {
            stream = new MediaStream([msTrack]);
            startAudioAnalyser(identity, stream);
          } else {
            // fallback: attach audio element and capture its stream (headless might not need play)
            const audioEl = track.attach();
            audioEl.muted = true;
            // don't append to body to avoid clutter; use hidden container optionally
            audioEl.play().catch(() => {}); // ignore autoplay errors
            if (typeof audioEl.captureStream === "function") {
              const s = audioEl.captureStream();
              if (s && s.getAudioTracks().length) {
                startAudioAnalyser(identity, s);
              }
            }
          }
        } catch (e) {
          console.warn("audio analyser setup failed for", identity, e);
        }
      }
    };

    const detachTrack = (participant, track) => {
      const identity = participant?.identity || participant?.sid || String(participant);
      if (!identity || !track) return;

      if (track.kind === "video") {
        const el = document.getElementById(`video-${identity}`);
        if (el) {
          try { track.detach(el); } catch (e) {}
          try { el.remove(); } catch (e) {}
        }
        setParticipants((prev) => {
          const next = new Map(prev);
          const p = next.get(identity);
          if (p) {
            p.hasVideo = false;
            p.videoEl = null;
            next.set(identity, p);
          }
          return next;
        });
      } else if (track.kind === "audio") {
        const ac = audioCtxs.current.get(identity);
        if (ac) { try { ac.close(); } catch (e) {} audioCtxs.current.delete(identity); }
        const r = rafs.current.get(identity);
        if (r) cancelAnimationFrame(r);
        rafs.current.delete(identity);

        setParticipants((prev) => {
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

    const startAudioAnalyser = (identity, mediaStream) => {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ac = new AudioCtx();
        const src = ac.createMediaStreamSource(mediaStream);
        const analyser = ac.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        const data = new Float32Array(analyser.fftSize);
        audioCtxs.current.set(identity, ac);

        const tick = () => {
          analyser.getFloatTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
          const rms = Math.sqrt(sum / data.length);
          const speaking = rms > 0.01; // tuned for headless recording

          setParticipants((prev) => {
            const next = new Map(prev);
            const p = next.get(identity);
            if (p) {
              p.speaking = speaking;
              next.set(identity, p);
            }
            return next;
          });

          const handle = requestAnimationFrame(tick);
          rafs.current.set(identity, handle);
        };

        const handle = requestAnimationFrame(tick);
        rafs.current.set(identity, handle);
      } catch (err) {
        // don't block START_RECORDING on analyser errors
        console.warn("startAudioAnalyser failed for", identity, err);
      }
    };

    // Room event handlers
    const onParticipantConnected = (p) => safeAddParticipant(p);
    const onParticipantDisconnected = (p) => safeRemoveParticipant(p);
    const onTrackSubscribed = (track, pub, participant) => {
      attachOrUpdateTrack(participant, track);
    };
    const onTrackUnsubscribed = (track, pub, participant) => {
      detachTrack(participant, track);
    };

    const doConnect = async () => {
      try {
        await room.connect(wsUrl, token, { autoSubscribe: true });
        setConnected(true);

        // Add local and remote participants with defensive checks
        try {
          safeAddParticipant(room.localParticipant);
        } catch (e) {
          console.warn("localParticipant add failed", e);
        }

        try {
          // room.participants is a Map-like object; iterate defensively
          room.participants?.forEach?.((p) => {
            safeAddParticipant(p);
          });
        } catch (e) {
          console.warn("iterating room.participants failed", e);
        }

        // attach existing published tracks (defensive)
        try {
          room.participants?.forEach?.((p) => {
            try {
              p.tracks?.forEach?.((pub) => {
                if (pub.isSubscribed && pub.track) {
                  attachOrUpdateTrack(p, pub.track);
                }
              });
            } catch (e) {
              console.warn("iterating participant.tracks failed for", p.identity, e);
            }
          });

          // local participant published tracks (if any)
          room.localParticipant?.tracks?.forEach?.((pub) => {
            if (pub.isSubscribed && pub.track) {
              attachOrUpdateTrack(room.localParticipant, pub.track);
            }
          });
        } catch (e) {
          console.warn("attach existing tracks failed", e);
        }

        // wire events
        room.on("participantConnected", onParticipantConnected);
        room.on("participantDisconnected", onParticipantDisconnected);
        room.on("trackSubscribed", onTrackSubscribed);
        room.on("trackUnsubscribed", onTrackUnsubscribed);

        // Once connected and initial DOM attachments likely done, signal start
        if (!startedRef.current) {
          startedRef.current = true;
          // small delay to help headless chrome settle and to ensure video elements are attached
          setTimeout(() => {
            console.log("START_RECORDING");
            console.info("Template: START_RECORDING logged.");
          }, 350);
        }
      } catch (err) {
        console.error("Failed to connect recorder room:", err);
        // still log a helpful message so egress logs show the error
        console.error("Template connection error:", err?.message || err);
      }
    };

    doConnect();

    const cleanup = () => {
      try {
        room.off("participantConnected", onParticipantConnected);
        room.off("participantDisconnected", onParticipantDisconnected);
        room.off("trackSubscribed", onTrackSubscribed);
        room.off("trackUnsubscribed", onTrackUnsubscribed);
      } catch (e) { /* ignore */ }

      try { room.disconnect(); } catch (e) {}
      rafs.current.forEach((h) => cancelAnimationFrame(h));
      rafs.current.clear();
      audioCtxs.current.forEach((c) => { try { c.close(); } catch (e) {} });
      audioCtxs.current.clear();
    };

    const beforeUnload = () => {
      console.log("END_RECORDING");
      try { cleanup(); } catch (e) {}
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("unload", beforeUnload);

    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("unload", beforeUnload);
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Render tiles
  const tiles = Array.from(participants.values());
  const cols = Math.min(6, Math.ceil(Math.sqrt(Math.max(1, tiles.length))));

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#071027", padding: 12, boxSizing: "border-box", color: "#e6eef8", fontFamily: "Inter, Roboto, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <div>Recording Template</div>
        <div>Connected: {String(Boolean(roomRef.current && roomRef.current.state === "connected"))} — participants: {tiles.length}</div>
      </div>

      <div style={{ display: "grid", gap: 8, gridTemplateColumns: `repeat(${cols}, 1fr)`, height: "calc(100vh - 80px)" }}>
        {tiles.map((p) => (
          <div key={p.identity} style={{ borderRadius: 8, overflow: "hidden", minHeight: 120, background: "#0b1220", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
            {p.hasVideo && p.videoEl ? (
              <div style={{ width: "100%", height: "100%" }} ref={(node) => {
                if (!node) return;
                node.innerHTML = "";
                if (p.videoEl && p.videoEl instanceof HTMLElement) node.appendChild(p.videoEl);
              }} />
            ) : (
              <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, color: "#e6eef8" }} className={p.speaking ? "speaking" : ""}>
                <div style={{ fontWeight: 700 }}>{p.displayName}</div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>{p.hasAudio ? "Audio" : "Offline"}</div>
                {p.speaking && <div style={{ position: "absolute", bottom: 8, right: 8, width: 10, height: 10, borderRadius: "50%", background: "#6366f1", boxShadow: "0 0 0 6px rgba(99,102,241,0.08)" }} />}
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ textAlign: "center", marginTop: 8, color: "#9aa6bf", fontSize: 12 }}>
        Template will log START_RECORDING when ready. Ensure this page is reachable by egress.
      </div>
    </div>
  );
}
