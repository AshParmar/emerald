import { BACKEND_URL } from "@/lib/config";
import axios from "axios";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Bot, Loader2, PhoneOff, User } from "lucide-react";
import { Button } from "./ui/button";
import { VoiceOrb } from "./VoiceOrb";

type Status = "connecting" | "live" | "ending";

/** Attaches an analyser to a stream and returns a getter for its current volume level. */
function createLevelMeter(ctx: AudioContext, stream: MediaStream) {
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);

    return () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
            const v = (data[i]! - 128) / 128;
            sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        return Math.min(1, rms * 3.2);
    };
}

// Helper to convert an ArrayBuffer to a Base64 string
function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]!);
    }
    return window.btoa(binary);
}

export function Interview() {
    const { interviewId } = useParams();
    const navigate = useNavigate();

    const [status, setStatus] = useState<Status>("connecting");
    const [aiLevel, setAiLevel] = useState(0);
    const [userLevel, setUserLevel] = useState(0);

    // Resources to tear down on exit
    const backendWsRef = useRef<WebSocket | null>(null);
    const deepgramWsRef = useRef<WebSocket | null>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const userStreamRef = useRef<MediaStream | null>(null);
    const captureCtxRef = useRef<AudioContext | null>(null);   // 16kHz — mic capture only
    const playbackCtxRef = useRef<AudioContext | null>(null);  // browser default — AI audio playback
    const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
    const rafRef = useRef<number | null>(null);
    const isAiSpeakingRef = useRef<boolean>(false);            // true while AI audio chunks are queued
    const lastActivityEndRef = useRef<number>(0);              // timestamp of last activity_end sent
    const isMicActiveRef = useRef<boolean>(false);             // gate: only send mic audio during user turns

    // Playback timing queue for AI audio chunks
    const nextPlayTimeRef = useRef<number>(0);
    const aiAnalyserRef = useRef<AnalyserNode | null>(null);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            // 1a. Capture context at 16kHz — only used for mic → Vertex AI
            const captureCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
                sampleRate: 16000
            });
            console.log("ACTUAL AUDIO CONTEXT SAMPLE RATE:", captureCtx.sampleRate);
            captureCtxRef.current = captureCtx;

            // 1b. Playback context at browser default rate — used for AI audio + analyser
            const playbackCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
            console.log("PLAYBACK AUDIO CONTEXT SAMPLE RATE:", playbackCtx.sampleRate);
            playbackCtxRef.current = playbackCtx;

            // Setup Analyser for the AI's voice level meter (on playback context)
            const aiAnalyser = playbackCtx.createAnalyser();
            aiAnalyser.fftSize = 512;
            aiAnalyser.smoothingTimeConstant = 0.8;
            aiAnalyserRef.current = aiAnalyser;

            const aiData = new Uint8Array(aiAnalyser.fftSize);
            const getAiLevel = () => {
                aiAnalyser.getByteTimeDomainData(aiData);
                let sum = 0;
                for (let i = 0; i < aiData.length; i++) {
                    const v = (aiData[i]! - 128) / 128;
                    sum += v * v;
                }
                const rms = Math.sqrt(sum / aiData.length);
                return Math.min(1, rms * 3.2);
            };

            let userMeter: (() => number) | null = null;

            // 2. Request microphone access WITH echo cancellation to prevent AI audio loopback
            const ms = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                }
            });
            if (cancelled) {
                ms.getTracks().forEach((t) => t.stop());
                return;
            }
            userStreamRef.current = ms;
            // Mute mic initially — only unmute when it's the user's turn
            ms.getAudioTracks().forEach(t => { t.enabled = false; });
            // User level meter uses capture context (both at 16kHz — consistent)
            userMeter = createLevelMeter(captureCtx, ms);

            // 3. Setup WebSocket connection to our Python backend
            const wsScheme = window.location.protocol === "https:" ? "wss:" : "ws:";
            // Extract the domain/port from BACKEND_URL
            const urlObj = new URL(BACKEND_URL);
            const backendWsUrl = `${wsScheme}//${urlObj.host}/api/v1/session/live/${interviewId}`;
            
            const backendWs = new WebSocket(backendWsUrl);
            backendWsRef.current = backendWs;

            // Helper to play back Gemini raw PCM chunks (uses playbackCtx, NOT captureCtx)
            const playPcmChunk = (pcmBase64: string) => {
                try {
                    const binaryString = window.atob(pcmBase64);
                    const len = binaryString.length;
                    const bytes = new Uint8Array(len);
                    for (let i = 0; i < len; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }

                    // Convert 16-bit Int16 PCM bytes to Float32Array
                    const int16 = new Int16Array(bytes.buffer);
                    const float32 = new Float32Array(int16.length);
                    for (let i = 0; i < int16.length; i++) {
                        float32[i] = int16[i]! / 32768.0;
                    }

                    // Gemini Multimodal Live API returns 24kHz audio — use playbackCtx so it plays correctly
                    const audioBuffer = playbackCtx.createBuffer(1, float32.length, 24000);
                    audioBuffer.copyToChannel(float32, 0);

                    const source = playbackCtx.createBufferSource();
                    source.buffer = audioBuffer;

                    // Connect buffer source to AI analyser and speakers
                    source.connect(aiAnalyser);
                    source.connect(playbackCtx.destination);

                    // Queue audio chunks continuously to prevent clicking/gaps
                    const currentTime = playbackCtx.currentTime;
                    if (nextPlayTimeRef.current < currentTime) {
                        nextPlayTimeRef.current = currentTime;
                    }
                    // Mark AI as speaking; clear the flag when this chunk finishes playing
                    isAiSpeakingRef.current = true;
                    source.onended = () => {
                        // Only clear if nothing else is queued (i.e., currentTime >= nextPlayTime)
                        if (playbackCtx.currentTime >= nextPlayTimeRef.current - 0.05) {
                            isAiSpeakingRef.current = false;
                        }
                    };
                    source.start(nextPlayTimeRef.current);
                    nextPlayTimeRef.current += audioBuffer.duration;
                } catch (e) {
                    console.error("Audio playback error:", e);
                }
            };

            backendWs.onopen = () => {
                if (cancelled) {
                    backendWs.close();
                    return;
                }
                setStatus("live");

                // Start recording raw microphone and streaming it to the backend
                // captureCtx is already at 16kHz, so ratio=1 — no downsampling needed
                const source = captureCtx.createMediaStreamSource(ms);
                const processor = captureCtx.createScriptProcessor(2048, 1, 1);
                audioProcessorRef.current = processor;

                source.connect(processor);
                processor.connect(captureCtx.destination);

                processor.onaudioprocess = (e) => {
                    const inputData = e.inputBuffer.getChannelData(0);
                    // captureCtx is already 16kHz — no resampling needed
                    const inputRate = captureCtxRef.current?.sampleRate || 16000;
                    const outputRate = 16000;
                    const ratio = inputRate / outputRate;
                    
                    const outLength = Math.floor(inputData.length / ratio);
                    const pcmData = new Int16Array(outLength);
                    
                    for (let i = 0; i < outLength; i++) {
                        const inIdx = Math.floor(i * ratio);
                        const s = Math.max(-1, Math.min(1, inputData[inIdx]!));
                        pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    }

                // Send base64 PCM over WebSocket — but only during user's turn
                    if (backendWs.readyState === WebSocket.OPEN && isMicActiveRef.current) {
                        const base64Audio = arrayBufferToBase64(pcmData.buffer);
                        backendWs.send(JSON.stringify({ audio: base64Audio }));
                    }
                };
            };

            backendWs.onmessage = (e) => {
                const data = JSON.parse(e.data);
                
                // If Gemini sent audio back
                if (data.audio) {
                    playPcmChunk(data.audio);
                }
                
                // When AI finishes its turn — wait for audio to drain, then unmute mic for user
                if (data.turn_complete) {
                    const drainMs = Math.max(1000, (nextPlayTimeRef.current - (playbackCtxRef.current?.currentTime ?? 0)) * 1000 + 400);
                    setTimeout(() => {
                        isAiSpeakingRef.current = false;
                        isMicActiveRef.current = true;
                        // Physically unmute the mic track so Vertex AI VAD can hear user
                        userStreamRef.current?.getAudioTracks().forEach(t => { t.enabled = true; });
                        console.log("[turn_complete] AI audio drained — mic unmuted for user");
                    }, drainMs);
                }

            };

            backendWs.onclose = () => {
                setStatus("ending");
            };

            // 4. Stream mic to Deepgram for live user transcriptions
            const DEEPGRAM_KEY = "";  // Add your Deepgram API Key here to enable user transcripts
            if (DEEPGRAM_KEY) {
                const deepgramWs = new WebSocket("wss://api.deepgram.com/v1/listen", [
                    "token",
                    DEEPGRAM_KEY,
                ]);
                deepgramWsRef.current = deepgramWs;

                deepgramWs.onopen = () => {
                    const mediaRecorder = new MediaRecorder(ms, { mimeType: "audio/webm" });
                    recorderRef.current = mediaRecorder;
                    mediaRecorder.start(250);
                    mediaRecorder.addEventListener("dataavailable", (event) => {
                        if (deepgramWs.readyState === WebSocket.OPEN) {
                            deepgramWs.send(event.data);
                        }
                    });
                };

                deepgramWs.onmessage = (message) => {
                    try {
                        const received = JSON.parse(message.data);
                        const transcript = received.channel?.alternatives[0]?.transcript;
                        if (transcript) {
                            axios.post(`${BACKEND_URL}/api/v1/session/user/response/${interviewId}`, {
                                message: transcript,
                            });
                        }
                    } catch (err) {
                        console.error("Deepgram transcript save failed:", err);
                    }
                };
            } else {
                console.warn("Deepgram API Key not set. Live user transcription will be bypassed.");
            }

            // VAD variables
            let isUserCurrentlySpeaking = false;
            let lastSpeechTime = performance.now();
            const SILENCE_THRESHOLD = 0.03;
            const SILENCE_DURATION_MS = 1500;
            const ACTIVITY_END_COOLDOWN_MS = 3000; // prevent spamming activity_end

            // Animation tick driving the volume visualizers
            const tick = () => {
                const currentAiLevel = getAiLevel();
                setAiLevel(currentAiLevel);
                
                if (userMeter) {
                    const currentLevel = userMeter();
                    setUserLevel(currentLevel);

                    // Only do VAD when AI is NOT speaking and mic is open
                    if (!isAiSpeakingRef.current && isMicActiveRef.current) {
                        if (currentLevel > SILENCE_THRESHOLD) {
                            if (!isUserCurrentlySpeaking) {
                                // User just started speaking — signal Vertex AI to start collecting audio
                                isUserCurrentlySpeaking = true;
                                console.log("[VAD] User started speaking — sending activity_start");
                                if (backendWs.readyState === WebSocket.OPEN) {
                                    backendWs.send(JSON.stringify({ type: "activity_start" }));
                                }
                            }
                            lastSpeechTime = performance.now();
                        } else {
                            if (isUserCurrentlySpeaking && (performance.now() - lastSpeechTime > SILENCE_DURATION_MS)) {
                                isUserCurrentlySpeaking = false;
                                const now = performance.now();
                                if (now - lastActivityEndRef.current > ACTIVITY_END_COOLDOWN_MS) {
                                    lastActivityEndRef.current = now;
                                    isMicActiveRef.current = false;
                                    // Physically mute the mic track
                                    userStreamRef.current?.getAudioTracks().forEach(t => { t.enabled = false; });
                                    console.log("[VAD] User stopped speaking — sending activity_end, mic muted");
                                    if (backendWs.readyState === WebSocket.OPEN) {
                                        backendWs.send(JSON.stringify({ type: "activity_end" }));
                                    }
                                }
                            }
                        }
                    } else if (isAiSpeakingRef.current) {
                        // AI is speaking — reset user speech state so we don't get false triggers
                        isUserCurrentlySpeaking = false;
                        lastSpeechTime = performance.now();
                    }
                }
                
                rafRef.current = requestAnimationFrame(tick);
            };
            rafRef.current = requestAnimationFrame(tick);
        })();

        return () => {
            cancelled = true;
            cleanup();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [interviewId]);

    function cleanup() {
        try {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            
            // Stop audio processor
            if (audioProcessorRef.current) {
                try {
                    audioProcessorRef.current.disconnect();
                } catch (e) {
                    console.error("Error disconnecting audio processor:", e);
                }
                audioProcessorRef.current = null;
            }

            try {
                if (recorderRef.current && recorderRef.current.state !== "inactive") {
                    recorderRef.current.stop();
                }
            } catch (e) {
                console.error("Error stopping media recorder:", e);
            }

            try {
                deepgramWsRef.current?.close();
            } catch (e) {}

            try {
                backendWsRef.current?.close();
            } catch (e) {}

            try {
                userStreamRef.current?.getTracks().forEach((t) => {
                    try {
                        t.stop();
                    } catch (err) {}
                });
            } catch (e) {}

            try {
                captureCtxRef.current?.close().catch(() => {});
            } catch (e) {}
            try {
                playbackCtxRef.current?.close().catch(() => {});
            } catch (e) {}
        } catch (globalError) {
            console.error("Global error in cleanup:", globalError);
        }
    }

    function endInterview() {
        setStatus("ending");
        cleanup();
        navigate(`/result/${interviewId}`);
    }

    const aiSpeaking = aiLevel > 0.06 && aiLevel >= userLevel;
    const userSpeaking = userLevel > 0.06 && userLevel > aiLevel;

    return (
        <main className="flex h-screen w-screen flex-col overflow-hidden bg-[#faf8f5] dark:bg-[#121110] text-[#2d2925] dark:text-[#f3f0eb]">
            {/* Header */}
            <header className="flex items-center justify-between px-6 py-5 border-b border-[#e8e2d9] dark:border-[#38342e]">
                <div className="flex items-center gap-2 text-sm font-semibold tracking-wide uppercase text-[#8a7a67]">
                    <span className="relative flex size-2.5">
                        <span
                            className={
                                status === "live"
                                    ? "absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75"
                                    : "hidden"
                            }
                        />
                        <span
                            className={
                                "relative inline-flex size-2.5 rounded-full " +
                                (status === "live" ? "bg-emerald-500" : "bg-amber-500")
                            }
                        />
                    </span>
                    {status === "connecting" ? "Connecting…" : status === "ending" ? "Wrapping up…" : "Interview live"}
                </div>
                <span className="text-sm font-serif italic text-muted-foreground">Practice Session</span>
            </header>

            {/* Stage (2D Pulsing visualizer) */}
            <div className="flex flex-1 items-center justify-center px-6">
                {status === "connecting" ? (
                    <div className="flex flex-col items-center gap-3 text-[#8a7a67]">
                        <Loader2 className="size-8 animate-spin" />
                        <p className="text-sm font-medium">Setting up your Gemini interviewer & mic…</p>
                    </div>
                ) : (
                    <div className="flex w-full max-w-3xl items-center justify-center gap-12 sm:gap-24">
                        <VoiceOrb
                            level={aiLevel}
                            speaking={aiSpeaking}
                            label="Interviewer"
                            sublabel="Listening"
                            icon={Bot}
                            accent="violet"
                        />
                        <VoiceOrb
                            level={userLevel}
                            speaking={userSpeaking}
                            label="You"
                            sublabel="Mic on"
                            icon={User}
                            accent="emerald"
                        />
                    </div>
                )}
            </div>

            {/* Controls */}
            <footer className="flex justify-center px-6 py-8 border-t border-[#e8e2d9] dark:border-[#38342e] gap-4">
                <Button
                    variant="outline"
                    size="lg"
                    className="w-48 border-[#d2c8b8] dark:border-[#524c44] text-[#8a7a67] dark:text-[#a39785] hover:bg-[#f3f0eb] dark:hover:bg-[#23201d]"
                    onClick={() => {
                        if (backendWsRef.current?.readyState === WebSocket.OPEN) {
                            console.log("Manually ending turn");
                            backendWsRef.current.send(JSON.stringify({ type: "activity_end" }));
                        }
                    }}
                >
                    End Turn
                </Button>
                <Button
                    variant="destructive"
                    size="lg"
                    onClick={endInterview}
                    disabled={status === "ending"}
                    className="gap-2 rounded-full px-8 py-6 font-semibold bg-[#d97706] hover:bg-[#c26a05] text-white shadow-sm"
                >
                    {status === "ending" ? (
                        <Loader2 className="size-5 animate-spin" />
                    ) : (
                        <PhoneOff className="size-5" />
                    )}
                    End Practice Session
                </Button>
            </footer>
        </main>
    );
}
