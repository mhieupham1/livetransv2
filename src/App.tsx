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
type TextSize = "normal" | "large" | "extra-large" | "presentation";
type RealtimePartial = { segmentId: string; text: string; language: LanguageCode };
type RealtimeCompleted = { transcript: string; languages: string[] };

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
const TEXT_SIZE_STORAGE_KEY = "relay-transcript-text-size-v1";
const SILENCE_COMMIT_MS = 1_200;
const TEXT_SIZES: TextSize[] = ["normal", "large", "extra-large", "presentation"];
const TEXT_SIZE_LABELS: Record<TextSize, string> = {
  normal: "100%",
  large: "125%",
  "extra-large": "160%",
  presentation: "200%",
};

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
  trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" /></>,
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

function normalizeDetectedLanguage(value: string): LanguageCode | null {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  const base = normalized.split("-", 1)[0];
  if (["vi", "vie", "vietnamese"].includes(base)) return "vi";
  if (["en", "eng", "english"].includes(base)) return "en";
  if (["ja", "jp", "jpn", "japanese"].includes(base)) return "ja";
  return null;
}

function realtimeWebSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/transcribe/realtime`;
}

function cleanRealtimeTranscript(value: string) {
  return value.replace(/<end>/gi, "").trim();
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

function loadTextSize(): TextSize {
  const saved = localStorage.getItem(TEXT_SIZE_STORAGE_KEY);
  return TEXT_SIZES.includes(saved as TextSize) ? saved as TextSize : "normal";
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
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [textSize, setTextSize] = useState<TextSize>(loadTextSize);
  const [context, setContext] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [summary, setSummary] = useState("");
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [apiConfigured, setApiConfigured] = useState<boolean | null>(null);
  const [transcriptionModel, setTranscriptionModel] = useState("whisper-1");
  const [realtimePartial, setRealtimePartial] = useState<RealtimePartial | null>(null);

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
  const speechStartedAtRef = useRef(0);
  const lastVoiceAtRef = useRef(0);
  const shouldTranscribeRef = useRef(false);
  const activeLanguageRef = useRef<LanguageCode>("vi");
  const elapsedRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);
  const elapsedBeforePauseRef = useRef(0);
  const controllersRef = useRef(new Map<string, AbortController>());
  const conversationEpochRef = useRef(0);
  const realtimeSocketsRef = useRef(new Set<WebSocket>());
  const activeRealtimeSegmentRef = useRef("");
  const beginRealtimeRef = useRef<() => void>(() => undefined);
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
  const textSizeIndex = TEXT_SIZES.indexOf(textSize);
  const transcriptionProvider = transcriptionModel === "soniox-stt"
    ? "Soniox"
    : transcriptionModel === "grok-stt" ? "Grok" : "Whisper";

  useEffect(() => {
    fetch("/api/health")
      .then((response) => response.json())
      .then((data: { configured?: boolean; transcriptionModel?: string }) => {
        setApiConfigured(Boolean(data.configured));
        if (data.transcriptionModel) setTranscriptionModel(data.transcriptionModel);
      })
      .catch(() => setApiConfigured(false));
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-100)));
    panelEndsRef.current.forward?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    panelEndsRef.current.reverse?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [entries]);

  useEffect(() => {
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, textSize);
  }, [textSize]);

  const adjustTextSize = (direction: -1 | 1) => {
    const nextIndex = Math.min(TEXT_SIZES.length - 1, Math.max(0, textSizeIndex + direction));
    setTextSize(TEXT_SIZES[nextIndex]);
  };

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
    const text = cleanRealtimeTranscript(rawText);
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

  const routeTranscription = useCallback((
    rawText: string,
    detectedLanguages: string[],
    fallbackLanguage: LanguageCode,
    sessionSecond: number,
  ) => {
    const text = rawText.trim();
    if (!text) return;
    const rawLanguageCode = detectedLanguages.find((value) => value.trim())?.trim() || "";
    const detectedLanguage = normalizeDetectedLanguage(rawLanguageCode);
    if (rawLanguageCode && !detectedLanguage) {
      const detail = rawLanguageCode.toLowerCase() === "noise"
        ? `${transcriptionProvider} chỉ phát hiện tiếng ồn.`
        : `${transcriptionProvider} phát hiện ngôn ngữ “${rawLanguageCode}”, không thuộc cặp ${LANGUAGES[source].name} ↔ ${LANGUAGES[target].name}.`;
      setNotice(`${detail} Đoạn ghi âm đã được bỏ qua.`);
      return;
    }

    const routedLanguage = detectedLanguage || fallbackLanguage;
    if (routedLanguage !== source && routedLanguage !== target) {
      setNotice(`Đoạn ghi âm không thuộc cặp ${LANGUAGES[source].name} ↔ ${LANGUAGES[target].name} và đã được bỏ qua.`);
      return;
    }
    if (mode === "one-way" && routedLanguage !== source) {
      setNotice(`${transcriptionProvider} phát hiện ${LANGUAGES[routedLanguage].name}. Chế độ một chiều chỉ nhận ${LANGUAGES[source].name}.`);
      return;
    }
    if (detectedLanguage && mode === "two-way" && detectedLanguage !== activeLanguageRef.current) {
      activeLanguageRef.current = detectedLanguage;
      setActiveLanguage(detectedLanguage);
    }
    submitText(text, routedLanguage, sessionSecond);
  }, [mode, source, submitText, target, transcriptionProvider]);

  const transcribeAudio = useCallback(async (
    audio: Blob,
    durationMs: number,
    language: LanguageCode,
    sessionSecond: number,
  ) => {
    if (audio.size < 500) return;
    const conversationEpoch = conversationEpochRef.current;
    setTranscriptionCount((count) => count + 1);
    try {
      const form = new FormData();
      form.append("file", audio, "audio.webm");
      form.append("duration_ms", String(Math.round(durationMs)));
      form.append("language", language);
      if (context.trim()) form.append("prompt", context.trim());

      const response = await fetch("/api/transcribe", { method: "POST", body: form });
      const body = (await response.json().catch(() => null)) as {
        text?: string;
        languageCode?: string;
        error?: string;
      } | null;
      if (!response.ok) throw new Error(body?.error || `Không thể nhận giọng nói (HTTP ${response.status}).`);
      if (conversationEpoch !== conversationEpochRef.current) return;
      const text = body?.text?.trim();
      if (!text) return;
      routeTranscription(text, [body?.languageCode || ""], language, sessionSecond);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Không thể nhận dạng đoạn ghi âm.");
    } finally {
      setTranscriptionCount((count) => Math.max(0, count - 1));
    }
  }, [context, routeTranscription]);

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
    const segmentId = makeId();
    const segmentChunks: Blob[] = [];
    const segmentLanguage = activeLanguageRef.current;
    const languageHints = [segmentLanguage, source, target, ...Object.keys(LANGUAGES) as LanguageCode[]]
      .filter((language, index, values) => values.indexOf(language) === index);
    const sessionSecond = elapsedRef.current;
    const conversationEpoch = conversationEpochRef.current;
    let socket: WebSocket | null = null;
    let sendChain = Promise.resolve();
    let pendingFrames: ArrayBuffer[] = [];
    let queuedChunkCount = 0;
    let socketReady = false;
    let socketFailure = "";
    let settled = false;
    let settleCompletion: (result: RealtimeCompleted | null) => void = () => undefined;
    let settleReady: (ready: boolean) => void = () => undefined;
    const completion = new Promise<RealtimeCompleted | null>((resolve) => { settleCompletion = resolve; });
    const ready = new Promise<boolean>((resolve) => { settleReady = resolve; });
    const settle = (result: RealtimeCompleted | null) => {
      if (settled) return;
      settled = true;
      settleCompletion(result);
    };

    mediaRecorderRef.current = recorder;
    activeRealtimeSegmentRef.current = segmentId;
    setRealtimePartial(null);
    chunksRef.current = segmentChunks;
    segmentStartedAtRef.current = performance.now();
    segmentSecondRef.current = sessionSecond;
    segmentLanguageRef.current = segmentLanguage;
    speechDetectedRef.current = false;
    speechStartedAtRef.current = 0;
    shouldTranscribeRef.current = false;

    const beginRealtime = () => {
      if (socket) {
        queueAvailableChunks();
        return;
      }
      if (transcriptionModel !== "soniox-stt") return;
      const realtimeSocket = new WebSocket(realtimeWebSocketUrl());
      socket = realtimeSocket;
      realtimeSocketsRef.current.add(realtimeSocket);
      realtimeSocket.onopen = () => {
        socketReady = true;
        settleReady(true);
        realtimeSocket.send(JSON.stringify({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/webm" },
                transcription: {
                  model: "soniox-stt",
                  languages: languageHints,
                  ...(context.trim() ? { prompt: context.trim() } : {}),
                },
              },
            },
          },
        }));
        for (const frame of pendingFrames) realtimeSocket.send(frame);
        pendingFrames = [];
      };
      realtimeSocket.onmessage = (message) => {
        try {
          const event = JSON.parse(String(message.data)) as {
            type?: string;
            transcript?: string;
            tokens?: Array<{ language?: string }>;
            languages?: Array<{ code?: string } | string>;
            error?: { message?: string };
          };
          if (event.type === "transcription.partial") {
            if (activeRealtimeSegmentRef.current !== segmentId) return;
            const tokenLanguage = event.tokens
              ?.map((token) => normalizeDetectedLanguage(token.language || ""))
              .reverse()
              .find((language): language is LanguageCode => Boolean(language));
            const partialLanguage = tokenLanguage && (tokenLanguage === source || tokenLanguage === target)
              ? tokenLanguage
              : segmentLanguage;
            setRealtimePartial({
              segmentId,
              text: cleanRealtimeTranscript(event.transcript || ""),
              language: partialLanguage,
            });
          } else if (event.type === "conversation.item.input_audio_transcription.completed") {
            const detectedLanguages = (event.languages || []).map((language) => (
              typeof language === "string" ? language : language.code || ""
            ));
            settle({ transcript: cleanRealtimeTranscript(event.transcript || ""), languages: detectedLanguages });
          } else if (event.type === "error") {
            socketFailure = event.error?.message || "Soniox realtime trả về lỗi.";
            settle(null);
          }
        } catch {
          socketFailure = "Soniox realtime trả về dữ liệu không hợp lệ.";
          settle(null);
        }
      };
      realtimeSocket.onerror = () => {
        socketFailure = "Không kết nối được tới Soniox realtime.";
        settleReady(false);
        settle(null);
      };
      realtimeSocket.onclose = () => {
        realtimeSocketsRef.current.delete(realtimeSocket);
        if (!socketReady) settleReady(false);
        settle(null);
      };
      queueAvailableChunks();
    };
    const queueAvailableChunks = () => {
      if (!socket) return;
      while (queuedChunkCount < segmentChunks.length) {
        const chunk = segmentChunks[queuedChunkCount++];
        sendChain = sendChain.then(async () => {
          const frame = await chunk.arrayBuffer();
          if (socket?.readyState === WebSocket.OPEN) socket.send(frame);
          else if (socket?.readyState === WebSocket.CONNECTING) pendingFrames.push(frame);
        });
      }
    };
    beginRealtimeRef.current = beginRealtime;
    beginRealtime();

    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      segmentChunks.push(event.data);
      if (!speechDetectedRef.current) {
        // Giữ header WebM và khoảng 2 giây pre-roll, không gửi thời gian im lặng dài lên Soniox.
        if (segmentChunks.length > 9) segmentChunks.splice(1, segmentChunks.length - 9);
        return;
      }
      queueAvailableChunks();
    };
    recorder.onerror = () => {
      setNotice("Trình duyệt gặp lỗi khi ghi âm WebM.");
    };
    recorder.onstop = () => {
      const durationMs = Math.max(0, performance.now() - segmentStartedAtRef.current);
      const shouldTranscribe = shouldTranscribeRef.current;
      chunksRef.current = [];
      if (mediaRecorderRef.current === recorder) mediaRecorderRef.current = null;

      if (shouldTranscribe && segmentChunks.length) {
        const audio = new Blob(segmentChunks, { type: mimeType });
        void (async () => {
          if (!socket) {
            transcribeAudioRef.current(audio, durationMs, segmentLanguage, sessionSecond);
            return;
          }
          setTranscriptionCount((count) => count + 1);
          let useFallback = false;
          try {
            await sendChain;
            const isReady = await Promise.race([
              ready,
              new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 8_000)),
            ]);
            if (!isReady || socket?.readyState !== WebSocket.OPEN) {
              useFallback = true;
              return;
            }
            socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            const result = await Promise.race([
              completion,
              new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 25_000)),
            ]);
            if (!result || !result.transcript) {
              useFallback = true;
              return;
            }
            if (conversationEpoch !== conversationEpochRef.current) return;
            routeTranscription(result.transcript, result.languages, segmentLanguage, sessionSecond);
          } finally {
            setRealtimePartial((current) => current?.segmentId === segmentId ? null : current);
            setTranscriptionCount((count) => Math.max(0, count - 1));
            if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) socket.close();
            if (useFallback && conversationEpoch === conversationEpochRef.current) {
              if (socketFailure) console.warn("Realtime transcription fallback:", socketFailure);
              transcribeAudioRef.current(audio, durationMs, segmentLanguage, sessionSecond);
            }
          }
        })();
      } else {
        setRealtimePartial((current) => current?.segmentId === segmentId ? null : current);
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) socket.close();
      }
      if (captureActiveRef.current) window.setTimeout(() => startSegmentRef.current(), 30);
    };
    recorder.start(250);
  }, [context, routeTranscription, source, target, transcriptionModel]);

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

      if (rms > 0.022) {
        lastVoiceAtRef.current = now;
        if (!speechDetectedRef.current) {
          speechDetectedRef.current = true;
          speechStartedAtRef.current = now;
          beginRealtimeRef.current();
          setIsSpeaking(true);
        }
      } else if (speechDetectedRef.current && now - lastVoiceAtRef.current > SILENCE_COMMIT_MS) {
        finishSegment(true);
      } else if (speechDetectedRef.current && now - speechStartedAtRef.current > 30_000) {
        finishSegment(true);
      }
      vadFrameRef.current = requestAnimationFrame(monitorVoice);
    };
    vadFrameRef.current = requestAnimationFrame(monitorVoice);
  }, [finishSegment, recordingSupported]);

  useEffect(() => () => {
    controllersRef.current.forEach((controller) => controller.abort());
    realtimeSocketsRef.current.forEach((socket) => socket.close());
    realtimeSocketsRef.current.clear();
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

  const clearConversation = () => {
    if (!entries.length) return;
    if (!window.confirm("Xóa toàn bộ nội dung hội thoại? Hành động này không thể hoàn tác.")) return;
    conversationEpochRef.current += 1;
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
    realtimeSocketsRef.current.forEach((socket) => socket.close());
    realtimeSocketsRef.current.clear();
    window.speechSynthesis?.cancel();
    setEntries([]);
    setRealtimePartial(null);
    setSummary("");
    setShowSummary(false);
    setNotice(null);
    localStorage.removeItem(STORAGE_KEY);
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
    <section className={`transcript-panel ${(realtimePartial?.language || activeLanguage) === from && isListening ? "active-speaker" : ""}`}>
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
        {panelEntries.length === 0 && !(
          (activeLanguage === from && (isSpeaking || transcriptionCount > 0))
          || realtimePartial?.language === from
        ) ? (
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
        {realtimePartial?.language === from ? (
          <article className="transcript-entry interim realtime-partial">
            <time>{isSpeaking ? "TRỰC TIẾP" : "ĐANG HOÀN TẤT"}</time>
            <p className="original-text">{realtimePartial.text || "Đang nghe…"}</p>
          </article>
        ) : activeLanguage === from && isSpeaking && (
          <article className="transcript-entry interim">
            <time>ĐANG GHI</time>
            <p className="original-text">Đang nghe và nhận dạng trực tiếp…</p>
          </article>
        )}
        {activeLanguage === from && !isSpeaking && transcriptionCount > 0 && (
          <article className="transcript-entry transcribing">
            <time>{transcriptionProvider.toUpperCase()}</time>
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
    <div className={`app-shell text-size-${textSize}`}>
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
          <button className="danger-action" onClick={clearConversation} disabled={!entries.length} aria-label="Xóa hội thoại" title="Xóa toàn bộ hội thoại"><Icon name="trash" /></button>
          <button onClick={() => setShowSettings(true)} aria-label="Cài đặt" title="Cài đặt"><Icon name="settings" /></button>
        </div>
      </header>

      <main className="session-shell">
        <section className="session-controls">
          <div className="audio-source">
            <span className={`source-icon ${isListening ? "live" : ""}`}><Icon name="mic" /></span>
            <div><small>Nguồn âm thanh</small><strong>Microphone · {transcriptionProvider}</strong></div>
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

          <div className="toolbar-right">
            <div className="text-size-control" aria-label="Cỡ chữ transcript">
              <span>Cỡ chữ</span>
              <button onClick={() => adjustTextSize(-1)} disabled={textSizeIndex === 0} aria-label="Thu nhỏ chữ">A−</button>
              <output aria-live="polite">{TEXT_SIZE_LABELS[textSize]}</output>
              <button onClick={() => adjustTextSize(1)} disabled={textSizeIndex === TEXT_SIZES.length - 1} aria-label="Phóng to chữ">A+</button>
            </div>

            <div className="speaker-switch" aria-label="Chọn người đang nói">
              <span>Đang nghe:</span>
              <button className={activeLanguage === source ? "active" : ""} onClick={() => switchSpeaker(source)}>{LANGUAGES[source].name}</button>
              {mode === "two-way" && <button className={activeLanguage === target ? "active" : ""} onClick={() => switchSpeaker(target)}>{LANGUAGES[target].name}</button>}
            </div>
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
              ? `${transcriptionProvider} đang xử lý ${transcriptionCount} đoạn âm thanh`
              : sessionStatus === "running"
                ? `${isSpeaking ? "Đang ghi âm" : "Đang chờ giọng nói"} · ${LANGUAGES[activeLanguage].name}`
                : "Sẵn sàng bắt đầu"
          }</span>
          <span>WebM/Opus · {transcriptionProvider} STT · AI translation</span>
        </footer>
      </main>

      {showSettings && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowSettings(false)}>
          <section className="modal-card settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
            <header><div><span className="modal-icon"><Icon name="settings" /></span><div><h2 id="settings-title">Cài đặt phiên dịch</h2><p>Giúp AI hiểu đúng tên riêng và thuật ngữ.</p></div></div><button onClick={() => setShowSettings(false)} aria-label="Đóng"><Icon name="close" /></button></header>
            <label htmlFor="translation-context">Từ khóa và ngữ cảnh</label>
            <textarea id="translation-context" name="translation-context" value={context} onChange={(event) => setContext(event.target.value)} maxLength={1000} placeholder="Ví dụ: Cuộc họp về phần mềm y tế. Tên sản phẩm: MedFlow. Giữ nguyên các từ API, deployment…" />
            <div className="char-count">{context.length}/1000</div>
            <div className="text-size-setting">
              <span><strong>Cỡ chữ transcript</strong><small>Phóng to nguyên văn và bản dịch trên cả hai khung</small></span>
              <div>
                {TEXT_SIZES.map((size) => (
                  <button key={size} className={textSize === size ? "active" : ""} onClick={() => setTextSize(size)}>
                    {TEXT_SIZE_LABELS[size]}
                  </button>
                ))}
              </div>
            </div>
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
