import {
  FormEvent,
  ReactNode,
  SVGProps,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type LanguageCode = "vi" | "en" | "ja";
type SessionMode = "one-way" | "two-way";
type SessionStatus = "idle" | "running" | "paused";
type EntryStatus = "translating" | "done" | "error";

type ConversationEntry = {
  id: string;
  source: LanguageCode;
  target: LanguageCode;
  sourceText: string;
  translation: string;
  status: EntryStatus;
  createdAt: number;
  sessionSecond: number;
};

const LANGUAGES: Record<LanguageCode, { name: string; short: string; speechCode: string }> = {
  vi: { name: "Tiếng Việt", short: "VI", speechCode: "vi-VN" },
  en: { name: "English", short: "EN", speechCode: "en-US" },
  ja: { name: "日本語", short: "JA", speechCode: "ja-JP" },
};

const STORAGE_KEY = "relay-translation-session-v2";

const icons: Record<string, ReactNode> = {
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" />
    </>
  ),
  pause: <><path d="M9 5v14M15 5v14" /></>,
  play: <path d="m8 5 11 7-11 7Z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  swap: <><path d="M7 7h11l-3-3M17 17H6l3 3" /><path d="m18 7-3 3M6 17l3-3" /></>,
  volume: <><path d="M11 5 6 9H3v6h3l5 4Z" /><path d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12" /></>,
  volumeOff: <><path d="M11 5 6 9H3v6h3l5 4Z" /><path d="m17 10 4 4m0-4-4 4" /></>,
  download: <><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M5 19h14" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
  notes: <><path d="M6 3h12v18H6zM9 7h6M9 11h6M9 15h4" /></>,
  send: <><path d="m21 3-7 18-3-8-8-3Z" /><path d="m21 3-10 10" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  spark: <><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2Z" /><path d="m18.5 14 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z" /></>,
  chevron: <path d="m9 18 6-6-6-6" />,
};

function Icon({ name, ...props }: { name: string } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {icons[name]}
    </svg>
  );
}

function formatTime(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function formatEntryTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function loadHistory(): ConversationEntry[] {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value) as ConversationEntry[];
    return Array.isArray(parsed) ? parsed.slice(-100) : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [source, setSource] = useState<LanguageCode>("vi");
  const [target, setTarget] = useState<LanguageCode>("en");
  const [activeLanguage, setActiveLanguage] = useState<LanguageCode>("vi");
  const [mode, setMode] = useState<SessionMode>("two-way");
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [entries, setEntries] = useState<ConversationEntry[]>(loadHistory);
  const [manualText, setManualText] = useState<Record<LanguageCode, string>>({ vi: "", en: "", ja: "" });
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [transcriptionCount, setTranscriptionCount] = useState(0);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [context, setContext] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [summary, setSummary] = useState("");
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [apiConfigured, setApiConfigured] = useState<boolean | null>(null);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const vadFrameRef = useRef<number | null>(null);
  const captureActiveRef = useRef(false);
  const chunksRef = useRef<Blob[]>([]);
  const segmentStartedAtRef = useRef(0);
  const segmentSecondRef = useRef(0);
  const segmentLanguageRef = useRef<LanguageCode>("vi");
  const speechDetectedRef = useRef(false);
  const lastVoiceAtRef = useRef(0);
  const shouldTranscribeRef = useRef(false);
  const activeLanguageRef = useRef<LanguageCode>("vi");
  const elapsedRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);
  const elapsedBeforePauseRef = useRef(0);
  const controllersRef = useRef(new Map<string, AbortController>());
  const transcribeAudioRef = useRef<(audio: Blob, durationMs: number, language: LanguageCode, sessionSecond: number) => void>(() => undefined);
  const startSegmentRef = useRef<() => void>(() => undefined);
  const panelEndsRef = useRef<Record<string, HTMLDivElement | null>>({});

  const recordingSupported = Boolean(
    typeof navigator.mediaDevices !== "undefined"
    && typeof MediaRecorder !== "undefined"
    && (MediaRecorder.isTypeSupported("audio/webm;codecs=opus") || MediaRecorder.isTypeSupported("audio/webm")),
  );
  const forwardEntries = useMemo(() => entries.filter((entry) => entry.source === source), [entries, source]);
  const reverseEntries = useMemo(() => entries.filter((entry) => entry.source === target), [entries, target]);

  useEffect(() => {
    fetch("/api/health")
      .then((response) => response.json())
      .then((data: { configured?: boolean }) => setApiConfigured(Boolean(data.configured)))
      .catch(() => setApiConfigured(false));
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-100)));
    panelEndsRef.current.forward?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    panelEndsRef.current.reverse?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [entries]);

  useEffect(() => {
    if (sessionStatus !== "running") return;
    const timer = window.setInterval(() => {
      const startedAt = startedAtRef.current;
      if (!startedAt) return;
      const nextElapsed = elapsedBeforePauseRef.current + Math.floor((Date.now() - startedAt) / 1000);
      elapsedRef.current = nextElapsed;
      setElapsed(nextElapsed);
    }, 250);
    return () => window.clearInterval(timer);
  }, [sessionStatus]);

  const updateEntry = useCallback((id: string, update: Partial<ConversationEntry>) => {
    setEntries((current) => current.map((entry) => (entry.id === id ? { ...entry, ...update } : entry)));
  }, []);

  const speakTranslation = useCallback((text: string, language: LanguageCode) => {
    if (!voiceEnabled || !("speechSynthesis" in window)) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = LANGUAGES[language].speechCode;
    utterance.rate = language === "ja" ? 0.95 : 1;
    const voice = window.speechSynthesis.getVoices().find((item) => item.lang.startsWith(language));
    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance);
  }, [voiceEnabled]);

  const streamTranslation = useCallback(async (entry: ConversationEntry) => {
    const controller = new AbortController();
    controllersRef.current.set(entry.id, controller);

    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: entry.sourceText,
          source: entry.source,
          target: entry.target,
          context,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `Không thể dịch (HTTP ${response.status}).`);
      }
      if (!response.body) throw new Error("Dịch vụ không trả về dữ liệu.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let translated = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const event of events) {
          const dataLine = event.split("\n").find((line) => line.startsWith("data:"));
          if (!dataLine) continue;
          try {
            const payload = JSON.parse(dataLine.slice(5).trim()) as { delta?: string; error?: string };
            if (payload.error) throw new Error(payload.error);
            if (payload.delta) {
              translated += payload.delta;
              updateEntry(entry.id, { translation: translated });
            }
          } catch (error) {
            if (error instanceof SyntaxError) continue;
            throw error;
          }
        }
      }

      const finalText = translated.trim();
      if (!finalText) throw new Error("Mô hình không trả về bản dịch.");
      updateEntry(entry.id, { translation: finalText, status: "done" });
      speakTranslation(finalText, entry.target);
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Đã xảy ra lỗi khi dịch.";
      updateEntry(entry.id, { translation: message, status: "error" });
      setNotice(message);
    } finally {
      controllersRef.current.delete(entry.id);
    }
  }, [context, speakTranslation, updateEntry]);

  const submitText = useCallback((rawText: string, fromLanguage = activeLanguage, atSecond = elapsedRef.current) => {
    const text = rawText.trim();
    if (!text) return;
    const toLanguage = fromLanguage === source ? target : source;
    const entry: ConversationEntry = {
      id: makeId(),
      source: fromLanguage,
      target: toLanguage,
      sourceText: text,
      translation: "",
      status: "translating",
      createdAt: Date.now(),
      sessionSecond: atSecond,
    };
    setEntries((current) => [...current, entry]);
    setManualText((current) => ({ ...current, [fromLanguage]: "" }));
    setNotice(null);
    void streamTranslation(entry);
  }, [activeLanguage, source, streamTranslation, target]);

  useEffect(() => {
    activeLanguageRef.current = activeLanguage;
  }, [activeLanguage]);

  const transcribeAudio = useCallback(async (
    audio: Blob,
    durationMs: number,
    language: LanguageCode,
    sessionSecond: number,
  ) => {
    if (audio.size < 500) return;
    setTranscriptionCount((count) => count + 1);
    try {
      const form = new FormData();
      form.append("file", audio, "audio.webm");
      form.append("model", "whisper-1");
      form.append("duration_ms", String(Math.round(durationMs)));

      const response = await fetch("/api/transcribe", { method: "POST", body: form });
      const body = (await response.json().catch(() => null)) as { text?: string; error?: string } | null;
      if (!response.ok) throw new Error(body?.error || `Không thể nhận giọng nói (HTTP ${response.status}).`);
      const text = body?.text?.trim();
      if (text) submitText(text, language, sessionSecond);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Không thể nhận dạng đoạn ghi âm.");
    } finally {
      setTranscriptionCount((count) => Math.max(0, count - 1));
    }
  }, [submitText]);

  useEffect(() => {
    transcribeAudioRef.current = (audio, durationMs, language, sessionSecond) => {
      void transcribeAudio(audio, durationMs, language, sessionSecond);
    };
  }, [transcribeAudio]);

  const startSegment = useCallback(() => {
    const stream = mediaStreamRef.current;
    if (!stream || !captureActiveRef.current) return;
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32_000 });
    mediaRecorderRef.current = recorder;
    chunksRef.current = [];
    segmentStartedAtRef.current = performance.now();
    segmentSecondRef.current = elapsedRef.current;
    segmentLanguageRef.current = activeLanguageRef.current;
    speechDetectedRef.current = false;
    shouldTranscribeRef.current = false;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onerror = () => {
      setNotice("Trình duyệt gặp lỗi khi ghi âm WebM.");
    };
    recorder.onstop = () => {
      const durationMs = Math.max(0, performance.now() - segmentStartedAtRef.current);
      const chunks = chunksRef.current;
      const shouldTranscribe = shouldTranscribeRef.current;
      const language = segmentLanguageRef.current;
      const sessionSecond = segmentSecondRef.current;
      chunksRef.current = [];
      mediaRecorderRef.current = null;

      if (shouldTranscribe && chunks.length) {
        const audio = new Blob(chunks, { type: mimeType });
        transcribeAudioRef.current(audio, durationMs, language, sessionSecond);
      }
      if (captureActiveRef.current) window.setTimeout(() => startSegmentRef.current(), 30);
    };
    recorder.start();
  }, []);

  useEffect(() => {
    startSegmentRef.current = startSegment;
  }, [startSegment]);

  const finishSegment = useCallback((transcribe: boolean) => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    shouldTranscribeRef.current = transcribe && speechDetectedRef.current;
    setIsSpeaking(false);
    recorder.stop();
  }, []);

  const stopAudioCapture = useCallback((transcribePending = true) => {
    captureActiveRef.current = false;
    if (vadFrameRef.current !== null) cancelAnimationFrame(vadFrameRef.current);
    vadFrameRef.current = null;
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === "recording") {
      shouldTranscribeRef.current = transcribePending && speechDetectedRef.current;
      recorder.stop();
    }
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    speechDetectedRef.current = false;
    setIsSpeaking(false);
    setIsListening(false);
  }, []);

  const startAudioCapture = useCallback(async () => {
    if (!recordingSupported) {
      throw new Error("Trình duyệt chưa hỗ trợ ghi âm WebM/Opus. Bạn vẫn có thể nhập nội dung.");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const audioContext = new AudioContext();
    const sourceNode = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.35;
    sourceNode.connect(analyser);

    mediaStreamRef.current = stream;
    audioContextRef.current = audioContext;
    captureActiveRef.current = true;
    setIsListening(true);
    startSegmentRef.current();

    const samples = new Float32Array(analyser.fftSize);
    const monitorVoice = () => {
      if (!captureActiveRef.current) return;
      analyser.getFloatTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) energy += sample * sample;
      const rms = Math.sqrt(energy / samples.length);
      const now = performance.now();
      const segmentAge = now - segmentStartedAtRef.current;

      if (rms > 0.022) {
        lastVoiceAtRef.current = now;
        if (!speechDetectedRef.current) {
          speechDetectedRef.current = true;
          setIsSpeaking(true);
        }
      } else if (speechDetectedRef.current && now - lastVoiceAtRef.current > 700) {
        finishSegment(true);
      } else if (!speechDetectedRef.current && segmentAge > 15_000) {
        finishSegment(false);
      } else if (speechDetectedRef.current && segmentAge > 30_000) {
        finishSegment(true);
      }
      vadFrameRef.current = requestAnimationFrame(monitorVoice);
    };
    vadFrameRef.current = requestAnimationFrame(monitorVoice);
  }, [finishSegment, recordingSupported]);

  useEffect(() => () => {
    controllersRef.current.forEach((controller) => controller.abort());
    window.speechSynthesis?.cancel();
    stopAudioCapture(false);
  }, [stopAudioCapture]);

  const startSession = async () => {
    if (sessionStatus === "idle") {
      setElapsed(0);
      elapsedRef.current = 0;
      elapsedBeforePauseRef.current = 0;
    }
    try {
      setNotice(null);
      await startAudioCapture();
      startedAtRef.current = Date.now();
      setSessionStatus("running");
    } catch (error) {
      stopAudioCapture(false);
      setNotice(error instanceof Error && error.name === "NotAllowedError"
        ? "Trình duyệt chưa được cấp quyền micro."
        : error instanceof Error ? error.message : "Không thể khởi động micro.");
    }
  };

  const pauseSession = () => {
    elapsedBeforePauseRef.current = elapsed;
    startedAtRef.current = null;
    setSessionStatus("paused");
    stopAudioCapture(true);
  };

  const stopSession = () => {
    elapsedBeforePauseRef.current = elapsed;
    startedAtRef.current = null;
    setSessionStatus("idle");
    stopAudioCapture(true);
  };

  const switchSpeaker = (language: LanguageCode) => {
    if (language === activeLanguage) return;
    activeLanguageRef.current = language;
    setActiveLanguage(language);
    if (captureActiveRef.current) finishSegment(true);
  };

  const swapLanguages = () => {
    if (captureActiveRef.current) finishSegment(true);
    setSource(target);
    setTarget(source);
    activeLanguageRef.current = target;
    setActiveLanguage(target);
  };

  const changeSource = (next: LanguageCode) => {
    if (captureActiveRef.current) finishSegment(true);
    if (next === target) setTarget(source);
    setSource(next);
    activeLanguageRef.current = next;
    setActiveLanguage(next);
  };

  const changeTarget = (next: LanguageCode) => {
    if (captureActiveRef.current) finishSegment(true);
    if (next === source) setSource(target);
    setTarget(next);
  };

  const handleSubmit = (event: FormEvent, language: LanguageCode) => {
    event.preventDefault();
    submitText(manualText[language], language);
  };

  const exportTranscript = () => {
    const content = entries.map((entry) => [
      `[${formatEntryTime(entry.sessionSecond)}] ${LANGUAGES[entry.source].name}`,
      entry.sourceText,
      `${LANGUAGES[entry.target].name}: ${entry.translation}`,
      "",
    ].join("\n")).join("\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `phien-dich-${new Date().toISOString().slice(0, 10)}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const generateSummary = async () => {
    if (!entries.length) return;
    setShowSummary(true);
    setIsSummarizing(true);
    setSummary("");
    try {
      const response = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries, outputLanguage: "vi", context }),
      });
      const body = (await response.json()) as { summary?: string; error?: string };
      if (!response.ok || !body.summary) throw new Error(body.error || "Không thể tạo biên bản.");
      setSummary(body.summary);
    } catch (error) {
      setSummary(error instanceof Error ? error.message : "Không thể tạo biên bản.");
    } finally {
      setIsSummarizing(false);
    }
  };

  const renderPanel = (from: LanguageCode, to: LanguageCode, panelEntries: ConversationEntry[], panelKey: string) => (
    <section className={`transcript-panel ${activeLanguage === from && isListening ? "active-speaker" : ""}`}>
      <header className="panel-header">
        <div className="panel-language">
          <span>{LANGUAGES[from].short}</span>
          <strong>{LANGUAGES[from].name}</strong>
          <Icon name="chevron" />
          <span>{LANGUAGES[to].short}</span>
          <strong>{LANGUAGES[to].name}</strong>
        </div>
        <button
          className={`panel-audio ${voiceEnabled ? "on" : ""}`}
          onClick={() => setVoiceEnabled((value) => !value)}
          aria-label={voiceEnabled ? "Tắt phát giọng dịch" : "Bật phát giọng dịch"}
          title="Phát giọng bản dịch"
        >
          <Icon name={voiceEnabled ? "volume" : "volumeOff"} />
        </button>
      </header>

      <div className="transcript-scroll" aria-live="polite">
        {panelEntries.length === 0 && !(activeLanguage === from && (isSpeaking || transcriptionCount > 0)) ? (
          <div className="panel-empty">
            <span><Icon name="mic" /></span>
            <strong>Chưa có nội dung</strong>
            <p>Chọn người đang nói và bắt đầu phiên dịch.</p>
          </div>
        ) : panelEntries.map((entry) => (
          <article className="transcript-entry" key={entry.id}>
            <time>{formatEntryTime(entry.sessionSecond)}</time>
            <p className="original-text">{entry.sourceText}</p>
            <p className={`translated-text ${entry.status}`}>
              {entry.translation || <span className="typing"><i /><i /><i /></span>}
            </p>
          </article>
        ))}
        {activeLanguage === from && isSpeaking && (
          <article className="transcript-entry interim">
            <time>ĐANG GHI</time>
            <p className="original-text">Đang ghi âm lượt nói…</p>
          </article>
        )}
        {activeLanguage === from && !isSpeaking && transcriptionCount > 0 && (
          <article className="transcript-entry transcribing">
            <time>WHISPER</time>
            <p className="original-text">Đang nhận dạng giọng nói…</p>
          </article>
        )}
        <div ref={(node) => { panelEndsRef.current[panelKey] = node; }} />
      </div>

      <form className="panel-input" onSubmit={(event) => handleSubmit(event, from)}>
        <input
          id={`message-${from}`}
          name={`message-${from}`}
          value={manualText[from]}
          onChange={(event) => setManualText((current) => ({ ...current, [from]: event.target.value }))}
          placeholder={`Nhập bằng ${LANGUAGES[from].name} để thử…`}
          maxLength={4000}
        />
        <button type="submit" disabled={!manualText[from].trim()} aria-label={`Dịch từ ${LANGUAGES[from].name}`}>
          <Icon name="send" />
        </button>
      </form>
    </section>
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><Icon name="spark" /></span>
          <span><strong>Relay</strong><small>AI Interpreter</small></span>
        </div>

        <nav className="mode-tabs" aria-label="Chế độ phiên dịch">
          <button className={mode === "one-way" ? "active" : ""} onClick={() => { setMode("one-way"); switchSpeaker(source); }}>Một chiều</button>
          <button className={mode === "two-way" ? "active" : ""} onClick={() => setMode("two-way")}>Hai chiều</button>
        </nav>

        <div className="top-actions">
          <span className={`api-pill ${apiConfigured ? "ready" : ""}`}><i />{apiConfigured ? "AI sẵn sàng" : "Chưa có API"}</span>
          <button onClick={() => setShowSettings(true)} aria-label="Cài đặt"><Icon name="settings" /></button>
        </div>
      </header>

      <main className="session-shell">
        <section className="session-controls">
          <div className="audio-source">
            <span className={`source-icon ${isListening ? "live" : ""}`}><Icon name="mic" /></span>
            <div><small>Nguồn âm thanh</small><strong>Microphone · Whisper</strong></div>
          </div>

          <div className="transport">
            {sessionStatus === "running" ? (
              <button className="control-button pause" onClick={pauseSession} aria-label="Tạm dừng"><Icon name="pause" /></button>
            ) : (
              <button className="control-button play" onClick={() => void startSession()} aria-label="Bắt đầu"><Icon name="play" /></button>
            )}
            <button className="control-button stop" onClick={stopSession} disabled={sessionStatus === "idle" && elapsed === 0} aria-label="Kết thúc"><Icon name="stop" /></button>
          </div>

          <div className="session-timeline">
            <div className={`waveform ${isListening ? "moving" : ""}`}>
              {Array.from({ length: 42 }, (_, index) => <i key={index} style={{ height: `${7 + ((index * 13) % 18)}px` }} />)}
            </div>
            <time>{formatTime(elapsed)}</time>
          </div>

          <div className="session-tools">
            <button className={voiceEnabled ? "active" : ""} onClick={() => setVoiceEnabled((value) => !value)} title="Phát giọng dịch"><Icon name={voiceEnabled ? "volume" : "volumeOff"} /></button>
            <button onClick={exportTranscript} disabled={!entries.length} title="Tải transcript"><Icon name="download" /></button>
            <button onClick={() => void generateSummary()} disabled={!entries.length} title="Biên bản AI"><Icon name="notes" /></button>
          </div>
        </section>

        <section className="language-toolbar">
          <div className="language-pair">
            <label htmlFor="source-language">Ngôn ngữ 1</label>
            <select id="source-language" name="source-language" value={source} onChange={(event) => changeSource(event.target.value as LanguageCode)}>
              {(Object.keys(LANGUAGES) as LanguageCode[]).map((code) => <option key={code} value={code}>{LANGUAGES[code].name}</option>)}
            </select>
            <button onClick={swapLanguages} aria-label="Đổi ngôn ngữ"><Icon name="swap" /></button>
            <label htmlFor="target-language">Ngôn ngữ 2</label>
            <select id="target-language" name="target-language" value={target} onChange={(event) => changeTarget(event.target.value as LanguageCode)}>
              {(Object.keys(LANGUAGES) as LanguageCode[]).map((code) => <option key={code} value={code}>{LANGUAGES[code].name}</option>)}
            </select>
          </div>

          <div className="speaker-switch" aria-label="Chọn người đang nói">
            <span>Đang nghe:</span>
            <button className={activeLanguage === source ? "active" : ""} onClick={() => switchSpeaker(source)}>{LANGUAGES[source].name}</button>
            {mode === "two-way" && <button className={activeLanguage === target ? "active" : ""} onClick={() => switchSpeaker(target)}>{LANGUAGES[target].name}</button>}
          </div>
        </section>

        {notice && <div className="notice" role="alert"><span>!</span>{notice}<button onClick={() => setNotice(null)}>×</button></div>}

        <div className={`transcript-grid ${mode}`}>
          {renderPanel(source, target, forwardEntries, "forward")}
          {mode === "two-way" && renderPanel(target, source, reverseEntries, "reverse")}
        </div>

        <footer className="session-footer">
          <span><i className={sessionStatus === "running" ? "online" : ""} />{
            transcriptionCount > 0
              ? `Whisper đang xử lý ${transcriptionCount} đoạn âm thanh`
              : sessionStatus === "running"
                ? `${isSpeaking ? "Đang ghi âm" : "Đang chờ giọng nói"} · ${LANGUAGES[activeLanguage].name}`
                : "Sẵn sàng bắt đầu"
          }</span>
          <span>WebM/Opus · Whisper STT · AI translation</span>
        </footer>
      </main>

      {showSettings && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowSettings(false)}>
          <section className="modal-card settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
            <header><div><span className="modal-icon"><Icon name="settings" /></span><div><h2 id="settings-title">Cài đặt phiên dịch</h2><p>Giúp AI hiểu đúng tên riêng và thuật ngữ.</p></div></div><button onClick={() => setShowSettings(false)} aria-label="Đóng"><Icon name="close" /></button></header>
            <label htmlFor="translation-context">Từ khóa và ngữ cảnh</label>
            <textarea id="translation-context" name="translation-context" value={context} onChange={(event) => setContext(event.target.value)} maxLength={1000} placeholder="Ví dụ: Cuộc họp về phần mềm y tế. Tên sản phẩm: MedFlow. Giữ nguyên các từ API, deployment…" />
            <div className="char-count">{context.length}/1000</div>
            <label className="toggle-row"><span><strong>Phát giọng bản dịch</strong><small>Đọc bản dịch sau mỗi câu hoàn chỉnh</small></span><input type="checkbox" checked={voiceEnabled} onChange={(event) => setVoiceEnabled(event.target.checked)} /></label>
            <footer><button className="primary-button" onClick={() => setShowSettings(false)}>Lưu cài đặt</button></footer>
          </section>
        </div>
      )}

      {showSummary && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowSummary(false)}>
          <section className="modal-card summary-modal" role="dialog" aria-modal="true" aria-labelledby="summary-title" onMouseDown={(event) => event.stopPropagation()}>
            <header><div><span className="modal-icon ai"><Icon name="notes" /></span><div><h2 id="summary-title">Biên bản AI</h2><p>Tóm tắt phiên hội thoại bằng tiếng Việt.</p></div></div><button onClick={() => setShowSummary(false)} aria-label="Đóng"><Icon name="close" /></button></header>
            <div className={`summary-content ${isSummarizing ? "loading" : ""}`}>{isSummarizing ? <><span className="summary-loader" /><p>AI đang tạo biên bản…</p></> : <pre>{summary}</pre>}</div>
            <footer><button onClick={() => setShowSummary(false)}>Đóng</button><button className="primary-button" onClick={() => navigator.clipboard.writeText(summary)} disabled={!summary || isSummarizing}>Sao chép</button></footer>
          </section>
        </div>
      )}
    </div>
  );
}
