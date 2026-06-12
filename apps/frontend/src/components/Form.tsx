import { useState, useRef, DragEvent } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { toast } from "sonner";
import axios from "axios";
import { BACKEND_URL } from "@/lib/config";
import { useNavigate } from "react-router";
import { ArrowRight, FileText, Loader2, Sparkles, Upload, User, X, Bot, Shield, CheckCircle2 } from "lucide-react";

export function Form() {
    const [name, setName] = useState("");
    const [file, setFile] = useState<File | null>(null);
    const [dragActive, setDragActive] = useState(false);
    const [loading, setLoading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const navigate = useNavigate();

    // Handle drag events
    const handleDrag = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "dragenter" || e.type === "dragover") {
            setDragActive(true);
        } else if (e.type === "dragleave") {
            setDragActive(false);
        }
    };

    // Handle dropped files
    const handleDrop = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);

        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            const droppedFile = e.dataTransfer.files[0];
            if (droppedFile.type === "application/pdf") {
                setFile(droppedFile);
            } else {
                toast.error("Please upload a valid PDF resume.");
            }
        }
    };

    // Handle file selection from button click
    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setFile(e.target.files[0]);
        }
    };

    const onButtonClick = () => {
        fileInputRef.current?.click();
    };

    const removeFile = () => {
        setFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    async function onSubmit() {
        if (!file) {
            toast.error("Please upload your resume to start.");
            return;
        }

        setLoading(true);
        const formData = new FormData();
        formData.append("file", file);
        if (name.trim()) {
            formData.append("name", name.trim());
        }

        try {
            const response = await axios.post(`${BACKEND_URL}/api/v1/pre-interview`, formData, {
                headers: {
                    "Content-Type": "multipart/form-data",
                },
            });
            navigate(`/interview/${response.data.id}`);
        } catch (e) {
            toast.error("Something went wrong processing your resume. Please try again.");
            setLoading(false);
        }
    }

    return (
        <main className="relative min-h-screen w-screen flex items-center justify-center bg-[#faf8f5] dark:bg-[#121110] px-6 py-12 text-[#2d2925] dark:text-[#f3f0eb] overflow-x-hidden">
            
            {/* Soft background grid accent */}
            <div className="absolute inset-0 bg-[linear-gradient(to_right,#e8e2d9_1px,transparent_1px),linear-gradient(to_bottom,#e8e2d9_1px,transparent_1px)] dark:bg-[linear-gradient(to_right,#38342e_1px,transparent_1px),linear-gradient(to_bottom,#38342e_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)] opacity-30 pointer-events-none" />

            <div className="relative z-10 w-full max-w-5xl grid grid-cols-1 md:grid-cols-12 gap-12 items-center">
                
                {/* LEFT COLUMN: Editorial & Features */}
                <div className="md:col-span-6 flex flex-col text-left">
                    <span className="self-start mb-6 inline-flex items-center gap-2 rounded-full border border-[#ebd9c7] dark:border-[#3a2e22] bg-[#f9f1e8] dark:bg-[#20170f] px-3.5 py-1.5 text-xs font-bold tracking-wide text-[#b45309]">
                        <Sparkles className="size-3.5 text-[#d97706] animate-pulse" />
                        GEMINI 2.5 LIVE ENGINE
                    </span>

                    <h1 className="font-serif text-4xl sm:text-5xl font-semibold leading-tight tracking-tight text-[#1f1a17] dark:text-white">
                        Practice real-time technical interviews.
                    </h1>
                    
                    <p className="mt-6 text-base text-[#6f675f] dark:text-[#b4aba2] leading-relaxed">
                        Upload your PDF resume. Our pipeline extracts your skills, tools, and background to spin up a customized voice mock interview.
                    </p>

                    {/* Features list */}
                    <div className="mt-8 flex flex-col gap-4">
                        <div className="flex items-start gap-3">
                            <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-500 shrink-0 mt-0.5" />
                            <div>
                                <h4 className="text-sm font-semibold text-[#1f1a17] dark:text-white">Low-latency Voice (PCM streaming)</h4>
                                <p className="text-xs text-[#8a7a67] mt-0.5">Continuous bidirectional WebSocket connection for smooth flow.</p>
                            </div>
                        </div>
                        <div className="flex items-start gap-3">
                            <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-500 shrink-0 mt-0.5" />
                            <div>
                                <h4 className="text-sm font-semibold text-[#1f1a17] dark:text-white">Structured Evaluation</h4>
                                <p className="text-xs text-[#8a7a67] mt-0.5">LangGraph evaluates technical correctness and communication skills separately.</p>
                            </div>
                        </div>
                    </div>

                    {/* Mock Profile Card Preview (Visual Interest) */}
                    <div className="mt-10 p-5 rounded-2xl border border-[#e8e2d9] dark:border-[#38342e] bg-[#f5f1e9] dark:bg-[#1a1715] shadow-xs flex flex-col gap-3 max-w-sm">
                        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#8a7a67]">
                            <Bot className="size-4 text-[#d97706]" />
                            Parsed Agent Config
                        </div>
                        <div className="flex items-center gap-3 mt-1">
                            <div className="size-9 rounded-full bg-[#ebd9c7] dark:bg-[#383028] grid place-items-center font-bold text-xs text-[#8a7a67]">JD</div>
                            <div>
                                <p className="text-xs font-bold text-[#1f1a17] dark:text-white">Sample Candidate</p>
                                <p className="text-[10px] text-[#8a7a67]">Senior Backend Developer</p>
                            </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5 mt-2">
                            <span className="text-[10px] bg-white dark:bg-[#24211e] px-2 py-0.5 rounded border border-[#e8e2d9] dark:border-[#38342e]">Python</span>
                            <span className="text-[10px] bg-white dark:bg-[#24211e] px-2 py-0.5 rounded border border-[#e8e2d9] dark:border-[#38342e]">FastAPI</span>
                            <span className="text-[10px] bg-white dark:bg-[#24211e] px-2 py-0.5 rounded border border-[#e8e2d9] dark:border-[#38342e]">LangGraph</span>
                        </div>
                    </div>
                </div>

                {/* RIGHT COLUMN: Action Card */}
                <div className="md:col-span-6">
                    <div className="w-full rounded-2xl border border-[#e8e2d9] dark:border-[#38342e] bg-white dark:bg-[#1a1816] p-8 shadow-sm">
                        
                        <h3 className="font-serif text-xl font-semibold text-[#1f1a17] dark:text-white mb-6">Setup your profile</h3>

                        {/* Name Input */}
                        <div className="mb-6 text-left">
                            <label className="text-xs font-bold uppercase tracking-wider text-[#8a7a67] block mb-2">
                                Candidate Name
                            </label>
                            <div className="flex items-center gap-2.5 rounded-xl border border-[#e8e2d9] dark:border-[#38342e] px-3.5 py-2 focus-within:border-[#827568] focus-within:ring-2 focus-within:ring-[#827568]/10 bg-[#fdfdfc] dark:bg-[#121110]">
                                <User className="size-4 text-[#8a7a67] shrink-0" />
                                <Input
                                    value={name}
                                    placeholder="Enter your name"
                                    onChange={(e) => setName(e.target.value)}
                                    disabled={loading}
                                    className="border-0 bg-transparent shadow-none focus-visible:ring-0 p-0 text-sm h-8"
                                />
                            </div>
                        </div>

                        {/* Drag and Drop Resume Field */}
                        <div className="mb-8 text-left">
                            <label className="text-xs font-bold uppercase tracking-wider text-[#8a7a67] block mb-2">
                                Upload Resume (PDF)
                            </label>
                            
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="application/pdf"
                                onChange={handleFileChange}
                                className="hidden"
                            />

                            {!file ? (
                                <div
                                    onDragEnter={handleDrag}
                                    onDragLeave={handleDrag}
                                    onDragOver={handleDrag}
                                    onDrop={handleDrop}
                                    onClick={onButtonClick}
                                    className={`flex flex-col items-center justify-center border-2 border-dashed rounded-2xl p-10 cursor-pointer transition-all ${
                                        dragActive
                                            ? "border-[#d97706] bg-[#d97706]/5"
                                            : "border-[#e8e2d9] dark:border-[#38342e] hover:border-[#827568] bg-[#fdfdfc] dark:bg-[#121110] hover:bg-[#faf9f7] dark:hover:bg-[#171514]"
                                    }`}
                                >
                                    <div className="size-12 rounded-full bg-[#f5f1e9] dark:bg-[#201d1a] grid place-items-center mb-4 text-[#827568]">
                                        <Upload className="size-5" />
                                    </div>
                                    <p className="text-sm font-medium">
                                        Drag & drop your PDF resume here
                                    </p>
                                    <p className="text-xs text-[#a0958a] mt-1.5">
                                        or click to <span className="text-[#d97706] font-semibold">browse files</span>
                                    </p>
                                </div>
                            ) : (
                                /* Selected File Preview */
                                <div className="flex items-center justify-between rounded-xl border border-[#e8e2d9] dark:border-[#38342e] bg-[#fbfaf8] dark:bg-[#171514] p-4.5 animate-in fade-in duration-200">
                                    <div className="flex items-center gap-3">
                                        <div className="grid size-11 place-items-center rounded-xl bg-[#d97706]/10 text-[#d97706]">
                                            <FileText className="size-5.5" />
                                        </div>
                                        <div className="truncate">
                                            <p className="text-sm font-semibold text-[#1f1a17] dark:text-[#f3f0eb] truncate max-w-xs">
                                                {file.name}
                                            </p>
                                            <p className="text-xs text-[#a0958a]">
                                                {(file.size / 1024 / 1024).toFixed(2)} MB
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={removeFile}
                                        disabled={loading}
                                        className="p-2 rounded-lg hover:bg-[#ebd9c7]/30 text-[#827568] transition-colors"
                                    >
                                        <X className="size-4" />
                                    </button>
                                </div>
                            )}
                        </div>

                        {/* Action Submit Button */}
                        <Button
                            disabled={loading}
                            onClick={onSubmit}
                            className="w-full py-6.5 rounded-xl font-semibold gap-2 bg-[#d97706] hover:bg-[#c26a05] text-white shadow-sm shrink-0 text-sm"
                        >
                            {loading ? (
                                <>
                                    <Loader2 className="size-5 animate-spin" />
                                    Parsing Resume with Gemini...
                                </>
                            ) : (
                                <>
                                    Start Practice Session
                                    <ArrowRight className="size-5" />
                                </>
                            )}
                        </Button>

                        <div className="mt-4 flex justify-center items-center gap-1.5 text-xs text-[#8a7a67]">
                            <Shield className="size-3.5" />
                            Data remains local & secure
                        </div>
                    </div>
                </div>
            </div>
        </main>
    );
}
