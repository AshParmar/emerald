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
    const audioCtxRef = useRef<AudioContext | null>(null);
    const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
    const rafRef = useRef<number | null>(null);

    // Playback timing queue for AI audio chunks
    const nextPlayTimeRef = useRef<number>(0);
    const aiAnalyserRef = useRef<AnalyserNode | null>(null);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            // 1. Initialize Audio Context (Standardized at 16kHz for microphone sampling)
            const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
                sampleRate: 16000
            });
            console.log("ACTUAL AUDIO CONTEXT SAMPLE RATE:", audioCtx.sampleRate);
            audioCtxRef.current = audioCtx;

            // Setup Analyser for the AI's voice level meter
            const aiAnalyser = audioCtx.createAnalyser();
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

            // 2. Request microphone access
            const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
            if (cancelled) {
                ms.getTracks().forEach((t) => t.stop());
                return;
            }
            userStreamRef.current = ms;
            userMeter = createLevelMeter(audioCtx, ms);

            // 3. Setup WebSocket connection to our Python backend
            const wsScheme = window.location.protocol === "https:" ? "wss:" : "ws:";
            // Extract the domain/port from BACKEND_URL
            const urlObj = new URL(BACKEND_URL);
            const backendWsUrl = `${wsScheme}//${urlObj.host}/api/v1/session/live/${interviewId}`;
            
            const backendWs = new WebSocket(backendWsUrl);
            backendWsRef.current = backendWs;

            // Helper to play back Gemini raw PCM chunks
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

                    // Gemini Multimodal Live API returns 24kHz audio output
                    const audioBuffer = audioCtx.createBuffer(1, float32.length, 24000);
                    audioBuffer.copyToChannel(float32, 0);

                    const source = audioCtx.createBufferSource();
                    source.buffer = audioBuffer;

                    // Connect buffer source to AI analyser and speakers
                    source.connect(aiAnalyser);
                    source.connect(audioCtx.destination);

                    // Queue audio chunks continuously to prevent clicking/gaps
                    const currentTime = audioCtx.currentTime;
                    if (nextPlayTimeRef.current < currentTime) {
                        nextPlayTimeRef.current = currentTime;
                    }
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
                const source = audioCtx.createMediaStreamSource(ms);
                // Buffer size 2048, 1 input channel, 1 output channel
                const processor = audioCtx.createScriptProcessor(2048, 1, 1);
                audioProcessorRef.current = processor;

                source.connect(processor);
                processor.connect(audioCtx.destination);

                processor.onaudioprocess = (e) => {
                    const inputData = e.inputBuffer.getChannelData(0);
                    // Downsample to exactly 16000Hz for Vertex AI
                    const inputRate = audioCtxRef.current?.sampleRate || 16000;
                    const outputRate = 16000;
                    const ratio = inputRate / outputRate;
                    
                    const outLength = Math.floor(inputData.length / ratio);
                    const pcmData = new Int16Array(outLength);
                    
                    for (let i = 0; i < outLength; i++) {
                        const inIdx = Math.floor(i * ratio);
                        const s = Math.max(-1, Math.min(1, inputData[inIdx]!));
                        pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    }

                    // Send base64 PCM over WebSocket
                    if (backendWs.readyState === WebSocket.OPEN) {
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
                
                // When AI finishes its turn, send activity_end so Vertex AI listens for user
                if (data.turn_complete) {
                    setTimeout(() => {
                        if (backendWs.readyState === WebSocket.OPEN) {
                            backendWs.send(JSON.stringify({ type: "activity_end" }));
                        }
                    }, 300);
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
            const SILENCE_THRESHOLD = 0.03;  // Low threshold - pick up any speech above background
            const SILENCE_DURATION_MS = 1500;

            // Animation tick driving the volume visualizers
            const tick = () => {
                const currentAiLevel = getAiLevel();
                setAiLevel(currentAiLevel);
                
                if (userMeter) {
                    const currentLevel = userMeter();
                    setUserLevel(currentLevel);

                    // Client-side Voice Activity Detection
                    if (currentLevel > SILENCE_THRESHOLD && currentLevel > currentAiLevel) {
                        isUserCurrentlySpeaking = true;
                        lastSpeechTime = performance.now();
                    } else {
                        // Volume is low
                        if (isUserCurrentlySpeaking && (performance.now() - lastSpeechTime > SILENCE_DURATION_MS)) {
                            // User finished speaking!
                            isUserCurrentlySpeaking = false;
                            
                            // Send "activity_end" to explicitly tell Vertex AI the user stopped speaking
                            if (backendWs.readyState === WebSocket.OPEN) {
                                backendWs.send(JSON.stringify({ type: "activity_end" }));
                            }
                        }
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
                audioCtxRef.current?.close().catch(() => {});
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
