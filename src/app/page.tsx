"use client";
import React, { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

type Role = "customer" | "agent";
type CaptionRole = Role | "unknown";

interface Caption {
    text: string;
    role: CaptionRole;
    at: number;
}

interface IntentInsight {
    role: Role;
    text: string;
    intent?: string;
    sentiment?: string;
    confidence?: number;
    at: number;
}

interface SignalMessage {
    type: "peer-joined" | "offer" | "answer" | "ice" | "caption" | "intent" | "peer-left";
    sdp?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
    text?: string;
    role?: CaptionRole;
    intent?: string;
    sentiment?: string;
    confidence?: number;
}

const parseSignalMessage = (data: MessageEvent["data"]): SignalMessage | null => {
    if (typeof data !== "string") return null;
    try {
        const parsed = JSON.parse(data) as Partial<SignalMessage>;
        if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
            return parsed as SignalMessage;
        }
    } catch (err) {
        console.warn("Failed to parse signaling message", err);
    }
    return null;
};

// Inline AudioWorklet that downmixes to mono and resamples to 16k, posts Int16 buffers
const workletBlobUrl: string = (() => {
    const workletCode = `
class Pcm16kWorklet extends AudioWorkletProcessor {
constructor() { super(); this._ratio = sampleRate / 16000; this._tail = []; }
_downmix(inputs){ const input = inputs[0]; if(!input||!input.length) return new Float32Array(0); const a=input[0]||new Float32Array(0); const b=input[1]||new Float32Array(a.length); const m=new Float32Array(a.length); for(let i=0;i<a.length;i++) m[i]=(a[i]+b[i])*0.5; return m; }
_resampleTo16k(f32){ const combined=this._tail.length?new Float32Array(this._tail.length+f32.length):f32.slice(); if(this._tail.length){combined.set(this._tail,0);combined.set(f32,this._tail.length);this._tail=[];} const step=this._ratio; const outLen=Math.floor(combined.length/step); const out=new Float32Array(outLen); for(let i=0,j=0;j<outLen;j++,i+=step) out[j]=combined[Math.floor(i)]||0; const consumed=Math.floor(outLen*step); if(consumed<combined.length) this._tail=combined.slice(consumed); return out; }
_floatToInt16(f32){ const out=new Int16Array(f32.length); for(let i=0;i<f32.length;i++){ let s=Math.max(-1,Math.min(1,f32[i])); out[i]= s<0 ? s*0x8000 : s*0x7FFF; } return out; }
process(inputs){ const mono=this._downmix(inputs); if(!mono.length) return true; const res=this._resampleTo16k(mono); if(res.length){ const i16=this._floatToInt16(res); this.port.postMessage(i16.buffer,[i16.buffer]); } return true; }
}
registerProcessor('pcm16k-worklet', Pcm16kWorklet);
`;
    return URL.createObjectURL(new Blob([workletCode], { type: "application/javascript" }));
})();

const envSocketBase = process.env.NEXT_PUBLIC_SOCKET_BASE_URL;
const socketBaseUrl = envSocketBase && envSocketBase.length > 0 ? envSocketBase.replace(/\/+$/, "") : "ws://localhost:8001";
const signalingUrl = `${socketBaseUrl}/ws`;
const asrUrl = `${socketBaseUrl}/asr`;

type OutgoingSignal =
    | { type: "offer"; sdp?: RTCSessionDescriptionInit | null }
    | { type: "answer"; sdp?: RTCSessionDescriptionInit | null }
    | { type: "ice"; candidate: RTCIceCandidateInit };

export default function Home() {
    const [room, setRoom] = useState<string>("demo");
    const [role, setRole] = useState<Role>("customer");
    const [connected, setConnected] = useState<boolean>(false);
    const [captions, setCaptions] = useState<Caption[]>([]);
    const [intentInsights, setIntentInsights] = useState<IntentInsight[]>([]);
    const [muted, setMuted] = useState<boolean>(false);

    const wsRef = useRef<WebSocket | null>(null); // signaling
    const pcRef = useRef<RTCPeerConnection | null>(null); // RTCPeerConnection
    const streamRef = useRef<MediaStream | null>(null); // local MediaStream
    const ctxRef = useRef<AudioContext | null>(null); // AudioContext
    const nodeRef = useRef<AudioWorkletNode | null>(null); // AudioWorkletNode
    const asrRef = useRef<WebSocket | null>(null); // ASR websocket
    const mutedRef = useRef<boolean>(false);
    const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

    const iceServers = useMemo<RTCIceServer[]>(() => ([{ urls: "stun:stun.l.google.com:19302" }]), []);

    useEffect(() => {
        mutedRef.current = muted;
        streamRef.current?.getAudioTracks().forEach((track) => {
            track.enabled = !muted;
        });
    }, [muted]);

    function connectSignaling(): WebSocket {
        if (wsRef.current) return wsRef.current;
        const ws = new WebSocket(signalingUrl);
        wsRef.current = ws;
        ws.onopen = () => {
            ws.send(JSON.stringify({ type: "join", room, role }));
            setConnected(true);
        };
        ws.onmessage = async (ev: MessageEvent) => {
            const msg = parseSignalMessage(ev.data);
            if (!msg) return;
            switch (msg.type) {
                case "peer-joined":
                    // no-op; agent will initiate offer below
                    break;
                case "offer": {
                    if (!msg.sdp) break;
                    const pc = await ensurePC();
                    await pc.setRemoteDescription(msg.sdp);
                    const ans = await pc.createAnswer();
                    await pc.setLocalDescription(ans);
                    await sendSignal({ type: "answer", sdp: pc.localDescription });
                    break;
                }
                case "answer": {
                    if (pcRef.current && pcRef.current.signalingState !== "stable" && msg.sdp) {
                        await pcRef.current.setRemoteDescription(msg.sdp);
                    }
                    break;
                }
                case "ice": {
                    if (pcRef.current && msg.candidate) {
                        try { await pcRef.current.addIceCandidate(msg.candidate); } catch { }
                    }
                    break;
                }
                case "caption": {
                    const text = msg.text;
                    if (typeof text !== "string" || text.length === 0) break;
                    setCaptions((c) => [...c, { text, role: msg.role ?? "unknown", at: Date.now() }]);
                    break;
                }
                case "intent": {
                    if (msg.role === "customer" && typeof msg.text === "string" && msg.text.length > 0) {
                        const text = msg.text;
                        setIntentInsights((items) => [
                            ...items,
                            {
                                role: "customer",
                                text,
                                intent: msg.intent,
                                sentiment: msg.sentiment,
                                confidence: msg.confidence,
                                at: Date.now(),
                            },
                        ]);
                    }
                    break;
                }
                case "peer-left":
                    // Optional: handle UI state
                    break;
            }
        };
        ws.onclose = () => { setConnected(false); wsRef.current = null; };
        return ws;
    }

    async function waitForSocketOpen(ws: WebSocket): Promise<void> {
        if (ws.readyState === WebSocket.OPEN) return;
        if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
            throw new Error("WebSocket is not open");
        }
        await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                ws.removeEventListener("open", handleOpen);
                ws.removeEventListener("error", handleFail);
                ws.removeEventListener("close", handleFail);
            };
            const handleOpen = () => {
                cleanup();
                resolve();
            };
            const handleFail = () => {
                cleanup();
                reject(new Error("WebSocket failed to open"));
            };
            ws.addEventListener("open", handleOpen, { once: true });
            ws.addEventListener("error", handleFail, { once: true });
            ws.addEventListener("close", handleFail, { once: true });
        });
    }

    async function sendSignal(payload: OutgoingSignal): Promise<void> {
        let ws = wsRef.current;
        if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
            ws = connectSignaling();
        }
        try {
            await waitForSocketOpen(ws);
            ws.send(JSON.stringify(payload));
        } catch (err) {
            console.warn("Failed to send signaling message", err);
        }
    }

    async function ensurePC(): Promise<RTCPeerConnection> {
        if (pcRef.current) return pcRef.current;
        const pc = new RTCPeerConnection({ iceServers });
        pcRef.current = pc;
        pc.onicecandidate = (e: RTCPeerConnectionIceEvent) => {
            if (!e.candidate) return;
            const candidate = typeof e.candidate.toJSON === "function" ? e.candidate.toJSON() : e.candidate;
            void sendSignal({ type: "ice", candidate });
        };
        pc.ontrack = (e: RTCTrackEvent) => {
            const el = remoteAudioRef.current;
            if (!el) return;
            const stream = e.streams[0] ?? new MediaStream([e.track]);
            if (el.srcObject !== stream) {
                el.srcObject = stream;
            }
            const playPromise = el.play();
            if (playPromise instanceof Promise) {
                playPromise.catch((err) => console.warn("Remote audio playback blocked:", err));
            }
        };
        return pc;
    }
    const startCall = async (): Promise<void> => {
        connectSignaling();
        setIntentInsights([]);
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        streamRef.current = stream;
        stream.getAudioTracks().forEach((track) => {
            track.enabled = !mutedRef.current;
        });


        const pc = await ensurePC();
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));


        // Role-based initiation: Agent sends offer, Customer waits.
        if (role === "agent") {
            const offer = await pc.createOffer({ offerToReceiveAudio: true });
            await pc.setLocalDescription(offer);
            await sendSignal({ type: "offer", sdp: pc.localDescription });
        }


        await startASR();
    };

    const stopCall = (): void => {
        nodeRef.current?.disconnect();
        ctxRef.current?.close();
        asrRef.current?.close();
        streamRef.current?.getTracks().forEach((t) => t.stop());
        pcRef.current?.close();


        nodeRef.current = null;
        ctxRef.current = null;
        asrRef.current = null;
        streamRef.current = null;
        pcRef.current = null;
        setIntentInsights([]);
        setMuted(false);
    };

    async function startASR(): Promise<void> {
        const AudioContextClass =
            window.AudioContext ||
            (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextClass) {
            console.warn("AudioContext is not supported in this browser.");
            return;
        }
        const ctx = new AudioContextClass({ sampleRate: 48000 });
        ctxRef.current = ctx;
        await ctx.audioWorklet.addModule(workletBlobUrl);
        if (!streamRef.current) {
            await ctx.close();
            return;
        }
        const src = ctx.createMediaStreamSource(streamRef.current);
        const worklet = new AudioWorkletNode(ctx, "pcm16k-worklet", { numberOfInputs: 1, numberOfOutputs: 0 });
        nodeRef.current = worklet;
        src.connect(worklet);


        const asr = new WebSocket(asrUrl);
        asr.binaryType = "arraybuffer";
        asr.onopen = () => {
            asr.send(JSON.stringify({ type: "init", room, role, lang: "en" }));
            worklet.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
                if (mutedRef.current) return;
                const buf = ev.data; // ArrayBuffer (Int16 @ 16k mono)
                if (asr.readyState === WebSocket.OPEN) asr.send(buf);
            };
        };
        asr.onmessage = (ev: MessageEvent<string>) => {
            try {
                const msg = JSON.parse(ev.data);
                if (msg.type === "error") console.warn("ASR error:", msg.message);
            } catch { }
        };
        asr.onclose = () => { };
        asrRef.current = asr;
    }
    const toggleMute = (): void => {
        setMuted((prev) => !prev);
    };
    return (
        <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 900, margin: '24px auto', padding: 16 }}>
            <h1>Customer ↔ Agent Audio Call + Live Transcription</h1>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
                <label>
                    Role:&nbsp;
                    <select value={role} onChange={(e: ChangeEvent<HTMLSelectElement>) => setRole(e.target.value as Role)}>
                        <option value="customer">Customer</option>
                        <option value="agent">Agent</option>
                    </select>
                </label>
                <input value={room} onChange={(e: ChangeEvent<HTMLInputElement>) => setRoom(e.target.value)} placeholder="room id" />
                <button onClick={startCall}>Start Call</button>
                <button onClick={stopCall}>End Call</button>
                <button onClick={toggleMute}>{muted ? 'Unmute' : 'Mute'}</button>
                <span style={{ opacity: 0.7 }}>{connected ? '🔌 signaling connected' : '⚪ not connected'}</span>
            </div>


            <audio id="remote-audio" ref={remoteAudioRef} autoPlay playsInline />


            <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginTop: 12 }}>
                <b>Live Captions</b>
                <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
                    {(['customer', 'agent'] as const).map((side) => (
                        <div key={side} style={{ flex: '1 1 220px', minWidth: 220 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                                <span style={{
                                    display: 'inline-block',
                                    fontSize: 12,
                                    padding: '2px 6px',
                                    borderRadius: 6,
                                    background: side === 'agent' ? '#e3f2fd' : '#e8f5e9',
                                    color: '#333',
                                    textTransform: 'capitalize'
                                }}>{side}</span>
                                <small style={{ opacity: 0.6 }}>seen by both participants</small>
                            </div>
                            <ul style={{ listStyle: 'none', padding: 0, margin: 0, minHeight: 140 }}>
                                {captions.filter((c) => c.role === side).map((c, i) => (
                                    <li key={`${side}-${i}`} style={{ marginBottom: 6, lineHeight: 1.4 }}>
                                        {c.text || <span style={{ opacity: 0.6 }}>…</span>}
                                    </li>
                                ))}
                                {!captions.some((c) => c.role === side) && (
                                    <li style={{ opacity: 0.6 }}>No transcript yet.</li>
                                )}
                            </ul>
                        </div>
                    ))}
                </div>
            </div>

            {role === 'agent' && (
                <div style={{ border: '1px solid #c7d0ff', borderRadius: 8, padding: 12, marginTop: 12, background: '#f6f7ff' }}>
                    <b>Customer Insights</b>
                    <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
                        {intentInsights.length === 0 && (
                            <li style={{ opacity: 0.6 }}>Insights will appear here when the customer speaks.</li>
                        )}
                        {intentInsights.map((insight, idx) => (
                            <li key={idx} style={{ marginBottom: 10, lineHeight: 1.4 }}>
                                <div style={{ fontSize: 12, opacity: 0.7 }}>
                                    {new Date(insight.at).toLocaleTimeString()} • confidence&nbsp;
                                    {typeof insight.confidence === 'number' ? insight.confidence.toFixed(2) : 'n/a'}
                                </div>
                                <div style={{ fontWeight: 600 }}>{insight.intent || 'Unknown intent'}</div>
                                <div style={{ fontSize: 13, opacity: 0.85 }}>Sentiment: {insight.sentiment || 'n/a'}</div>
                                <div style={{ fontSize: 13, marginTop: 4, opacity: 0.85 }}>{insight.text}</div>
                            </li>
                        ))}
                    </ul>
                </div>
            )}


            <p style={{ opacity: 0.7, marginTop: 12 }}>
                Open this page in two tabs/computers, select different roles, use the same room id, then click <i>Start Call</i> on both. The <b>Agent</b> creates the offer.
            </p>
        </div>
    );

}
