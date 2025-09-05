import React, { useEffect, useRef, useState } from "react";
import { Room } from "livekit-client";

/**
 * LiveKit Egress Recorder Template
 *
 * Usage:
 *  Deploy to Netlify (or similar) and supply URL to LiveKit startRoomCompositeEgress
 *  Example page URL passed to egress will be:
 *    https://your-template.netlify.app/?url=ws://your-livekit-host:7880&token=<recorder-token>
 *
 * IMPORTANT:
 *  - This template logs "START_RECORDING" once the room is connected and initial layout is rendered.
 *  - It logs "END_RECORDING" before unload/disconnect.
 *  - Ensure the egress worker can reach this deployed URL (egress runs inside Docker).
 */

export default function App() {
  const [connected, setConnected] = useState(false);
  const [participants, setParticipants] = useState(new Map()); // identity -> { identity, displayName, hasVideo, hasAudio, speaking, videoEl }
  const roomRef = useRef(null);
  const startLoggedRef = useRef(false);
  const rafsRef = useRef(new Map());
  const audioCtxRef = useRef(new Map());

  // read query params (LiveKit egress will pass url & token)
  const params = new URLSearchParams(window.location.search);
  const wsUrl = params.get("url") || params.get("wsUrl") || params.get("wssUrl");
  const token = params.get("token") || params.get("accessToken");

  useEffect(() => {
    // Ensure required params exist
    if (!wsUrl || !token) {
      console.error("Recorder template missing `url` or `token` query parameters.");
      document.body.innerHTML = `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; color:#FF4D4F; padding:24px;">
          <h2>Missing parameters</h2>
          <p>This template expects <code>?url=&lt;ws/wss url&gt;&amp;token=&lt;egress token&gt;</code></p>
        </div>
      `;
      return;
    }

    const room = new Room({ autoSubscribe: true });
    roomRef.current = room;

    const onParticipantConnected = (p) => {
      addParticipant(p.identity || p.sid);
    };
    const onParticipantDisconnected = (p) => {
      removeParticipant(p.identity || p.sid);
    };

    const onTrackSubscribed = (track, publication, participant) => {
      addOrUpdateTrack(participant.identity || participant.sid, track);
    };

    const onTrackUnsubscribed = (track, publication, participant) => {
      removeTrack(participant.identity || participant.sid, track);
    };

    const finishIfReady = async () => {
      // Called after initial connect and participant processing; ensures console START_RECORDING is emitted once.
      if (startLoggedRef.current) return;
      startLoggedRef.current = true;

      // Wait a short moment to let the UI render attached elements (helps headless chrome)
      await new Promise((res) => setTimeout(res, 350));

      // Signal to egress that rendering started
      console.log("START_RECORDING");
      console.info("Template: START_RECORDING logged. Recording should begin.");
    };

    const connect = async () => {
      try {
        await room.connect(wsUrl, token, { autoSubscribe: true });
        setConnected(true);

        // add local participant and existing remote participants
        addParticipant(room.localParticipant.identity || room.localParticipant.sid);
        room.participants.forEach((p) => addParticipant(p.identity || p.sid));

        // attach existing tracks
        room.participants.forEach((p) => {
          p.tracks.forEach((pub) => {
            if (pub.isSubscribed && pub.track) {
              addOrUpdateTrack(p.identity || p.sid, pub.track);
            }
          });
        });

        // also attach local participant's published (if any)
        room.localParticipant.tracks.forEach((pub) => {
          if (pub.isSubscribed && pub.track) {
            addOrUpdateTrack(room.localParticipant.identity || room.localParticipant.sid, pub.track);
          }
        });

        // event listeners
        room.on("participantConnected", onParticipantConnected);
        room.on("participantDisconnected", onParticipantDisconnected);
        room.on("trackSubscribed", onTrackSubscribed);
        room.on("trackUnsubscribed", onTrackUnsubscribed);

        // Wait for a tick then log START_RECORDING
        finishIfReady();
      } catch (err) {
        console.error("Failed to connect recorder room:", err);
      }
    };

    connect();

    const cleanup = () => {
      try {
        room.off("participantConnected", onParticipantConnected);
        room.off("participantDisconnected", onParticipantDisconnected);
        room.off("trackSubscribed", onTrackSubscribed);
        room.off("trackUnsubscribed", onTrackUnsubscribed);
      } catch (e) {}
      try {
        room.disconnect();
      } catch (e) {}
      // stop all analyser loops and close audio contexts
      rafsRef.current.forEach((id) => cancelAnimationFrame(id));
      rafsRef.current.clear();
      audioCtxRef.current.forEach((c) => {
        try { c.close(); } catch (e) {}
      });
      audioCtxRef.current.clear();
    };

    // on page unload, signal END_RECORDING
    const beforeUnload = () => {
      console.log("END_RECORDING");
      console.info("Template: END_RECORDING logged. Recording should finalize.");
      cleanup();
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

  // ------------------- participants/helpers -------------------
  const addParticipant = (identity) => {
    setParticipants((prev) => {
      if (prev.has(identity)) return prev;
      const next = new Map(prev);
      next.set(identity, {
        identity,
        displayName: identity,
        hasVideo: false,
        hasAudio: false,
        speaking: false,
        videoEl: null
      });
      return next;
    });
  };

  const removeParticipant = (identity) => {
    setParticipants((prev) => {
      const next = new Map(prev);
      const p = next.get(identity);
      if (p && p.videoEl && p.videoEl.remove) {
        try { p.videoEl.remove(); } catch (e) {}
      }
      next.delete(identity);

      // cleanup audio ctx + raf
      const ac = audioCtxRef.current.get(identity);
      if (ac) {
        try { ac.close(); } catch (e) {}
        audioCtxRef.current.delete(identity);
      }
      const raf = rafsRef.current.get(identity);
      if (raf) cancelAnimationFrame(raf);
      rafsRef.current.delete(identity);
      return next;
    });
  };

  const addOrUpdateTrack = (identity, track) => {
    if (!track) return;
    if (track.kind === "video") {
      // attach video DOM element
      const el = track.attach();
      el.id = `video-${identity}`;
      el.autoplay = true;
      el.playsInline = true;
      el.style.width = "100%";
      el.style.height = "100%";
      el.style.objectFit = "cover";

      setParticipants((prev) => {
        const next = new Map(prev);
        const p = next.get(identity) || { identity, displayName: identity };
        p.videoEl = el;
        p.hasVideo = true;
        next.set(identity, p);
        return next;
      });
    } else if (track.kind === "audio") {
      // audio: set up analyser to detect speaking
      setParticipants((prev) => {
        const next = new Map(prev);
        const p = next.get(identity) || { identity, displayName: identity };
        p.hasAudio = true;
        next.set(identity, p);
        return next;
      });

      // Hook up analyser from track.mediaStreamTrack if available
      try {
        const msTrack = track.mediaStreamTrack || (track.track && track.track.mediaStreamTrack);
        if (msTrack) {
          const stream = new MediaStream([msTrack]);
          startAnalyser(identity, stream);
        } else {
          // fallback: attach to element and capture stream
          const ael = track.attach();
          ael.muted = true;
          ael.play().catch(() => {});
          const stream = ael.captureStream ? ael.captureStream() : null;
          if (stream) startAnalyser(identity, stream);
        }
      } catch (e) {
        console.warn("audio analyser setup failed for", identity, e);
      }
    }
  };

  const removeTrack = (identity, track) => {
    if (!track) return;
    if (track.kind === "video") {
      const el = document.getElementById(`video-${identity}`);
      if (el) {
        try { track.detach(el); } catch (e) {}
        el.remove();
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
      // shutdown analyser
      const ac = audioCtxRef.current.get(identity);
      if (ac) { try { ac.close(); } catch (e) {} audioCtxRef.current.delete(identity); }
      const raf = rafsRef.current.get(identity);
      if (raf) cancelAnimationFrame(raf);
      rafsRef.current.delete(identity);

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

  const startAnalyser = (identity, mediaStream) => {
    // create audio context per participant and analyse RMS for speaking detection
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const ac = new AudioContextClass();
      const src = ac.createMediaStreamSource(mediaStream);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const data = new Float32Array(analyser.fftSize);

      audioCtxRef.current.set(identity, ac);

      const loop = () => {
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        const speaking = rms > 0.01; // tuned threshold for headless recording

        // update participant speaking state
        setParticipants((prev) => {
          const next = new Map(prev);
          const p = next.get(identity);
          if (p) {
            p.speaking = speaking;
            next.set(identity, p);
          }
          return next;
        });

        const raf = requestAnimationFrame(loop);
        rafsRef.current.set(identity, raf);
      };

      const rafHandle = requestAnimationFrame(loop);
      rafsRef.current.set(identity, rafHandle);
    } catch (e) {
      console.warn("startAnalyser error:", e);
    }
  };

  // ------------------- Render -------------------
  const tiles = Array.from(participants.values());
  const cols = Math.min(6, Math.ceil(Math.sqrt(Math.max(1, tiles.length)))); // limit columns for readability

  return (
    <div className="page">
      <div className="header">
        <div>Recording Template</div>
        <div className="info">
          Connected: {connected ? "yes" : "no"} — participants: {tiles.length}
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {tiles.map((p) => (
          <div key={p.identity} className="tile">
            {p.hasVideo && p.videoEl ? (
              <div
                className="video-wrap"
                ref={(node) => {
                  if (!node) return;
                  node.innerHTML = "";
                  if (p.videoEl && p.videoEl instanceof HTMLElement) {
                    node.appendChild(p.videoEl);
                  }
                }}
              />
            ) : (
              <div className={`placeholder ${p.speaking ? "speaking" : ""}`}>
                <div className="name">{p.displayName || p.identity}</div>
                <div className="label">{p.hasAudio ? "Audio" : "Offline"}</div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* small footer to indicate we logged START_RECORDING */}
      <div className="footer">
        <small>Template logs START_RECORDING when ready. Ensure this page is reachable by the egress worker.</small>
      </div>
    </div>
  );
}
