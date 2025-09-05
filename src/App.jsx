import React, { useEffect, useRef, useState } from "react";
import { Room, Track } from "livekit-client";
import EgressHelper from "@livekit/egress-sdk";

/**
 * Custom LiveKit Egress template in plain JS
 * - Shows all participants
 * - Video if publishing video
 * - Placeholder if no media
 * - Pulsing placeholder if audio only
 */

export default function App() {
  const [tiles, setTiles] = useState(new Map());
  const roomRef = useRef(null);
  const startedRef = useRef(false);
  const snapshotTimerRef = useRef(null);
  const speakingTimerRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wsUrl = params.get("url") || params.get("wsUrl");
    const token = params.get("token") || params.get("accessToken");

    if (!wsUrl || !token) {
      document.body.innerHTML = `<div style="padding:24px;color:#b91c1c">
        <h2>Missing parameters</h2>
        <p>Use ?url=&lt;ws/wss&gt;&token=&lt;recorder-token&gt;</p>
      </div>`;
      return;
    }

    const room = new Room({ autoSubscribe: true });
    roomRef.current = room;
    EgressHelper.setRoom(room);

    const safeAddTile = (identity, displayName) => {
      setTiles((prev) => {
        if (prev.has(identity)) return prev;
        const next = new Map(prev);
        next.set(identity, {
          identity,
          displayName: displayName || identity,
          videoEl: null,
          hasVideo: false,
          hasAudio: false,
          analyser: null,
          speaking: false,
        });
        return next;
      });
    };

    const safeRemoveTile = (identity) => {
      setTiles((prev) => {
        const next = new Map(prev);
        const t = next.get(identity);
        if (t?.videoEl && t.videoEl.parentElement) {
          try {
            t.videoEl.remove();
          } catch {}
        }
        next.delete(identity);
        return next;
      });
    };

    const attachVideo = (id, track) => {
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
        p.videoEl = el;
        p.hasVideo = true;
        next.set(id, p);
        return next;
      });
    };

    const attachAudio = (id, track) => {
      const audioEl = track.attach();
      audioEl.muted = true;
      audioEl.play().catch(() => {});

      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          const msTrack = track.mediaStreamTrack;
          const stream = msTrack ? new MediaStream([msTrack]) : null;
          if (stream) {
            const src = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            src.connect(analyser);
            setTiles((prev) => {
              const next = new Map(prev);
              const p = next.get(id) || { identity: id, displayName: id };
              p.hasAudio = true;
              p.analyser = analyser;
              next.set(id, p);
              return next;
            });
          }
        }
      } catch (e) {
        console.warn("audio analyser failed", e);
      }
    };

    const onTrackSubscribed = (track, pub, participant) => {
      const id = participant.identity;
      if (track.kind === Track.Kind.Video) attachVideo(id, track);
      else if (track.kind === Track.Kind.Audio) attachAudio(id, track);
    };

    const onParticipantConnected = (p) => {
      safeAddTile(p.identity, p.metadata || p.identity);
    };

    const onParticipantDisconnected = (p) => {
      safeRemoveTile(p.identity);
    };

    const startLogic = async () => {
      await room.connect(wsUrl, token, { autoSubscribe: true });

      safeAddTile(room.localParticipant.identity, room.localParticipant.metadata || room.localParticipant.identity);
      room.remoteParticipants.forEach((p) => {
        safeAddTile(p.identity, p.metadata || p.identity);
      });

      room.remoteParticipants.forEach((p) => {
        p.trackPublications?.forEach?.((pub) => {
          if (pub.isSubscribed && pub.track) {
            if (pub.kind === Track.Kind.Video) attachVideo(p.identity, pub.track);
            if (pub.kind === Track.Kind.Audio) attachAudio(p.identity, pub.track);
          }
        });
      });

      room.on("participantConnected", onParticipantConnected);
      room.on("participantDisconnected", onParticipantDisconnected);
      room.on("trackSubscribed", onTrackSubscribed);

      const FRAME_DECODE_TIMEOUT = 5000;
      const startTime = Date.now();

      const tick = async () => {
        let shouldStart = false;
        let hasVideo = false;
        let hasSubscribed = false;
        let hasDecoded = false;

        room.remoteParticipants.forEach((p) => {
          p.trackPublications.forEach((pub) => {
            if (pub.isSubscribed) hasSubscribed = true;
            if (pub.kind === Track.Kind.Video && pub.videoTrack) {
              hasVideo = true;
              const stats = pub.videoTrack.getRTCStatsReport();
              stats?.then((s) => {
                if (
                  Array.from(s).some(
                    (it) => it[1].type === "inbound-rtp" && (it[1].framesDecoded ?? 0) > 0
                  )
                ) {
                  hasDecoded = true;
                }
              });
            }
          });
        });

        const dt = Date.now() - startTime;
        if (hasDecoded) shouldStart = true;
        else if (!hasVideo && hasSubscribed && dt > 500) shouldStart = true;
        else if (dt > FRAME_DECODE_TIMEOUT && hasSubscribed) shouldStart = true;

        if (shouldStart && !startedRef.current) {
          startedRef.current = true;
          console.log("START_RECORDING");
          EgressHelper.startRecording();
        } else if (!startedRef.current) {
          setTimeout(tick, 100);
        }
      };
      tick();

      snapshotTimerRef.current = setInterval(() => {
        const snap = [];
        room.remoteParticipants.forEach((p) => {
          const pubs = [];
          p.trackPublications.forEach((pub) =>
            pubs.push({
              sid: pub.trackSid,
              kind: pub.kind,
              isSubscribed: pub.isSubscribed,
              source: pub.source,
            })
          );
          snap.push({ identity: p.identity, publications: pubs });
        });
        console.log("TEMPLATE_SNAPSHOT:", JSON.stringify(snap));
      }, 4000);
    };

    startLogic();

    speakingTimerRef.current = setInterval(() => {
      setTiles((prev) => {
        const next = new Map(prev);
        next.forEach((p, id) => {
          if (p.analyser) {
            const buf = new Uint8Array(p.analyser.frequencyBinCount);
            p.analyser.getByteFrequencyData(buf);
            const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
            p.speaking = avg > 20;
            next.set(id, p);
          }
        });
        return new Map(next);
      });
    }, 250);

    return () => {
      if (snapshotTimerRef.current) clearInterval(snapshotTimerRef.current);
      if (speakingTimerRef.current) clearInterval(speakingTimerRef.current);
      room.disconnect();
    };
  }, []);

  const arr = Array.from(tiles.values());
  const cols = Math.max(1, Math.ceil(Math.sqrt(arr.length)));

  return (
    <div className="template-root">
      <div className="grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {arr.map((t) => (
          <div className="tile" key={t.identity}>
            {t.hasVideo && t.videoEl ? (
              <div
                className="video-wrap"
                ref={(node) => {
                  if (!node) return;
                  node.innerHTML = "";
                  if (t.videoEl instanceof HTMLElement) node.appendChild(t.videoEl);
                }}
              />
            ) : (
              <div className={`placeholder ${t.speaking ? "speaking" : ""}`}>
                <div className="name">{t.displayName}</div>
                <div className="status">{t.hasAudio ? "Audio only" : "No media"}</div>
              </div>
            )}
          </div>
        ))}
      </div>

      <style>{`
        .template-root { height:100vh; background:#031029; color:#e6eef8; font-family:sans-serif; }
        .grid { display:grid; gap:8px; height:100%; }
        .tile { background:#0b1220; border-radius:8px; display:flex; align-items:center; justify-content:center; overflow:hidden; }
        .video-wrap video { width:100%; height:100%; object-fit:cover; }
        .placeholder { text-align:center; padding:16px; }
        .placeholder.speaking { box-shadow: 0 0 0 6px rgba(34,197,94,0.3); transition: box-shadow 120ms ease-in-out; }
        .name { font-weight:700; }
        .status { font-size:12px; opacity:0.7; }
      `}</style>
    </div>
  );
}
