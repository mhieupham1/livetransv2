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

type LanguageCode = "vi" | "en" | "ja" | "zh" | "ko" | "th";
type SessionMode = "one-way" | "two-way";
type SessionStatus = "idle" | "running" | "paused";
type EntryStatus = "translating" | "done" | "error";
type TextSize = "normal" | "large" | "extra-large" | "presentation";
type RealtimePartial = { segmentId: string; text: string; language: LanguageCode };
type RealtimeCompleted = { transcript: string; languages: string[] };
type AuthUser = {
  id: string;
  email: string;
  name: string;
  picture: string;
  plan: string;
  planName?: string;
  planKind?: "subscription" | "event";
  quotaSeconds: number;
  usedSeconds: number;
  bonusSeconds?: number;
  remainingSeconds: number | null;
  unlimited: boolean;
  periodResetsAt?: number;
};
type BillingOrder = {
  id: string;
  amountVnd: number;
  transferCode: string;
  status: "pending" | "paid" | "expired";
  planId: string | null;
  planName: string | null;
  kind: string;
  grantSeconds: number | null;
  qrImageUrl: string;
  bankAccount: string;
  bankAccountName: string;
};
type BillingPlan = {
  id: string;
  name: string;
  kind: "subscription" | "event";
  monthlySeconds: number;
  durationSeconds: number;
  priceVnd: number;
  description: string;
};

// Ngưỡng cảnh báo trước khi hết hạn mức (giây).
const QUOTA_WARN_SECONDS = 300;
const QUOTA_CRITICAL_SECONDS = 60;

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

const LANGUAGES: Record<LanguageCode, { name: string; short: string; speechCode: string; sttHint: string }> = {
  vi: { name: "Tiếng Việt", short: "VI", speechCode: "vi-VN", sttHint: "vietnamese" },
  en: { name: "English", short: "EN", speechCode: "en-US", sttHint: "english" },
  ja: { name: "日本語", short: "JA", speechCode: "ja-JP", sttHint: "japanese" },
  zh: { name: "中文", short: "ZH", speechCode: "zh-CN", sttHint: "chinese" },
  ko: { name: "한국어", short: "KO", speechCode: "ko-KR", sttHint: "korean" },
  th: { name: "ไทย", short: "TH", speechCode: "th-TH", sttHint: "thai" },
};

const STORAGE_KEY = "relay-translation-session-v2";
const TEXT_SIZE_STORAGE_KEY = "relay-transcript-text-size-v1";
const MOBILE_MERGED_VIEW_STORAGE_KEY = "relay-mobile-merged-view-v1";
const SETTINGS_STORAGE_KEY = "relay-settings-v1";
const THEME_STORAGE_KEY = "relay-theme-v1";

type ThemePreference = "light" | "dark" | "system";

function loadThemePreference(): ThemePreference {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

// "system" theo cài đặt máy; trình duyệt cũ không có matchMedia thì mặc định sáng.
function resolveTheme(preference: ThemePreference): "light" | "dark" {
  if (preference !== "system") return preference;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Đủ khoá cho mọi ngôn ngữ đang hỗ trợ; khởi tạo bằng map để thêm ngôn ngữ mới
// không phải sửa ba chỗ rời rạc.
const emptyManualText = Object.fromEntries(
  Object.keys(LANGUAGES).map((code) => [code, ""]),
) as Record<LanguageCode, string>;
const SILENCE_COMMIT_MS = 1_200;
// Nhịp lấy mẫu VAD. setInterval (không phải rAF) để vẫn chạy khi tab bị ẩn.
const VAD_INTERVAL_MS = 50;
const USAGE_HEARTBEAT_MS = 15_000;
const MIN_TRANSLATION_INTERVAL_MS = 700;
const PCM_SAMPLE_RATE = 24_000;
const PCM_PRE_ROLL_CHUNKS = 6;
const WEBM_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "video/webm;codecs=opus",
  "video/webm",
] as const;
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
  keyboard: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M10.5 10h.01M14 10h.01M17.5 10h.01M7 13h.01M10.5 13h.01M14 13h.01M17.5 13h.01M8 16h8" /></>,
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
  if (["zh", "zho", "chi", "cmn", "chinese", "mandarin"].includes(base)) return "zh";
  if (["ko", "kor", "korean"].includes(base)) return "ko";
  if (["th", "tha", "thai"].includes(base)) return "th";
  return null;
}

function realtimeWebSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/transcribe/realtime`;
}

async function apiFetch(input: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  const response = await fetch(input, {
    ...init,
    credentials: "include",
    headers,
  });
  return response;
}

function formatRemaining(seconds: number | null, unlimited: boolean) {
  if (unlimited || seconds === null) return "Không giới hạn";
  const total = Math.max(0, Math.floor(seconds));
  if (total >= 86_400) {
    // Gói Pro tính bằng tháng; hiển thị theo ngày thay vì "43200:00".
    const days = Math.floor(total / 86_400);
    const hours = Math.floor((total % 86_400) / 3_600);
    return hours ? `${days} ngày ${hours} giờ` : `${days} ngày`;
  }
  if (total >= 3_600) {
    // Gói 1–3 giờ: đọc theo giờ, tránh "180:00" khó hiểu.
    const hours = Math.floor(total / 3_600);
    const minutes = Math.floor((total % 3_600) / 60);
    return minutes ? `${hours} giờ ${minutes} phút` : `${hours} giờ`;
  }
  const minutes = Math.floor(total / 60);
  const rem = total % 60;
  return `${minutes}:${String(rem).padStart(2, "0")}`;
}

function formatVnd(amount: number) {
  return new Intl.NumberFormat("vi-VN").format(amount) + "đ";
}

function cleanRealtimeTranscript(value: string) {
  return value.replace(/<end>/gi, "").trim();
}

function supportedWebmMimeType() {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return null;
  return WEBM_MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || null;
}

function encodePcm16Base64(samples: Float32Array, inputSampleRate: number) {
  const outputLength = Math.max(1, Math.round(samples.length * PCM_SAMPLE_RATE / inputSampleRate));
  const bytes = new Uint8Array(outputLength * 2);
  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = index * inputSampleRate / PCM_SAMPLE_RATE;
    const leftIndex = Math.min(samples.length - 1, Math.floor(sourcePosition));
    const rightIndex = Math.min(samples.length - 1, leftIndex + 1);
    const fraction = sourcePosition - leftIndex;
    const sample = Math.max(-1, Math.min(1, samples[leftIndex] * (1 - fraction) + samples[rightIndex] * fraction));
    const pcm = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    bytes[index * 2] = pcm & 0xff;
    bytes[index * 2 + 1] = (pcm >> 8) & 0xff;
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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

function loadMobileMergedView() {
  return localStorage.getItem(MOBILE_MERGED_VIEW_STORAGE_KEY) !== "false";
}

// Ngữ cảnh thuật ngữ và các lựa chọn phiên dịch được nhớ giữa các lần mở trang:
// người dùng thường dịch cho cùng một dự án nên nhập lại mỗi lần là vô nghĩa.
type SavedSettings = {
  context: string;
  source: LanguageCode;
  target: LanguageCode;
  mode: SessionMode;
  voiceEnabled: boolean;
};

function loadSettings(): Partial<SavedSettings> {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const settings: Partial<SavedSettings> = {};
    if (typeof parsed.context === "string") settings.context = parsed.context.slice(0, 1_000);
    if (typeof parsed.source === "string" && parsed.source in LANGUAGES) settings.source = parsed.source as LanguageCode;
    if (typeof parsed.target === "string" && parsed.target in LANGUAGES) settings.target = parsed.target as LanguageCode;
    if (parsed.mode === "one-way" || parsed.mode === "two-way") settings.mode = parsed.mode;
    if (typeof parsed.voiceEnabled === "boolean") settings.voiceEnabled = parsed.voiceEnabled;
    return settings;
  } catch {
    return {};
  }
}

const savedSettings = loadSettings();

// Wake Lock giữ màn hình sáng trong lúc đang phiên dịch — trên mobile, màn hình tắt
// sẽ khiến người dùng mất dấu phiên và audio bị hệ điều hành hạ ưu tiên.
// Không phải trình duyệt nào cũng hỗ trợ, nên mọi lỗi đều bỏ qua.
type WakeLockSentinelLike = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: "release", listener: () => void) => void;
};

function canWakeLock() {
  return typeof navigator !== "undefined" && "wakeLock" in navigator;
}

export default function App() {
  const [source, setSource] = useState<LanguageCode>(savedSettings.source ?? "vi");
  const [target, setTarget] = useState<LanguageCode>(savedSettings.target ?? "en");
  const [activeLanguage, setActiveLanguage] = useState<LanguageCode>(savedSettings.source ?? "vi");
  const [mode, setMode] = useState<SessionMode>(savedSettings.mode ?? "two-way");
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("idle");
  // Bản ref để interval heartbeat đọc được trạng thái mới nhất mà không cần tạo lại timer.
  const sessionStatusRef = useRef<SessionStatus>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [entries, setEntries] = useState<ConversationEntry[]>(loadHistory);
  const [manualText, setManualText] = useState<Record<LanguageCode, string>>(emptyManualText);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [transcriptionCount, setTranscriptionCount] = useState(0);
  const [voiceEnabled, setVoiceEnabled] = useState(savedSettings.voiceEnabled ?? false);
  const [textSize, setTextSize] = useState<TextSize>(loadTextSize);
  const [theme, setTheme] = useState<ThemePreference>(loadThemePreference);
  const [mobileHeaderCollapsed, setMobileHeaderCollapsed] = useState(false);
  const [mobileMergedView, setMobileMergedView] = useState(loadMobileMergedView);
  const [mobileTextInputVisible, setMobileTextInputVisible] = useState(false);
  const [context, setContext] = useState(savedSettings.context ?? "");
  const [showSettings, setShowSettings] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [summary, setSummary] = useState("");
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [apiConfigured, setApiConfigured] = useState<boolean | null>(null);
  const [transcriptionModel, setTranscriptionModel] = useState("whisper-1");
  const [realtimePartial, setRealtimePartial] = useState<RealtimePartial | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [billingConfigured, setBillingConfigured] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [upgradeOrder, setUpgradeOrder] = useState<BillingOrder | null>(null);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [isCreatingOrder, setIsCreatingOrder] = useState(false);
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [quotaWarning, setQuotaWarning] = useState<"none" | "low" | "critical">("none");
  const googleButtonRef = useRef<HTMLDivElement | null>(null);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const pcmProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const pcmSinkRef = useRef<GainNode | null>(null);
  const pcmPreRollRef = useRef<string[]>([]);
  const pcmSegmentSenderRef = useRef<((audio: string) => void) | null>(null);
  const finishPcmSegmentRef = useRef<(transcribe: boolean) => void>(() => undefined);
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
  const translationQueueRef = useRef(Promise.resolve());
  const lastTranslationStartedAtRef = useRef(0);
  const realtimeSocketsRef = useRef(new Set<WebSocket>());
  const activeRealtimeSegmentRef = useRef("");
  const beginRealtimeRef = useRef<() => void>(() => undefined);
  const transcribeAudioRef = useRef<(audio: Blob, durationMs: number, language: LanguageCode, sessionSecond: number) => void>(() => undefined);
  const startSegmentRef = useRef<() => void>(() => undefined);
  const stopSessionRef = useRef<() => void>(() => undefined);
  const panelScrollsRef = useRef<Record<string, HTMLDivElement | null>>({});
  const mergedInputRef = useRef<HTMLInputElement | null>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const wakeLockWantedRef = useRef(false);

  // Xin wake lock; tự xin lại khi người dùng quay lại tab vì trình duyệt nhả lock
  // mỗi lần trang bị ẩn.
  const requestWakeLock = useCallback(async () => {
    wakeLockWantedRef.current = true;
    if (!canWakeLock() || wakeLockRef.current) return;
    try {
      const nav = navigator as Navigator & {
        wakeLock: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
      };
      const sentinel = await nav.wakeLock.request("screen");
      wakeLockRef.current = sentinel;
      sentinel.release = sentinel.release.bind(sentinel);
      // Hệ điều hành có thể tự nhả (hết pin, chuyển app) — bỏ tham chiếu để lần sau xin lại.
      sentinel.addEventListener?.("release", () => {
        if (wakeLockRef.current === sentinel) wakeLockRef.current = null;
      });
    } catch {
      // Không hỗ trợ hoặc bị từ chối: phiên vẫn chạy, chỉ là màn hình có thể tắt.
      wakeLockRef.current = null;
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    wakeLockWantedRef.current = false;
    const sentinel = wakeLockRef.current;
    wakeLockRef.current = null;
    void sentinel?.release().catch(() => undefined);
  }, []);

  // Khai báo trước mọi effect gọi tới nó (heartbeat, translate, transcribe) — dù closure
  // vẫn chạy đúng sau render, thứ tự này tránh bẫy temporal dead zone.
  const openUpgrade = useCallback(async (planId?: string) => {
    setShowUpgrade(true);
    setUpgradeError(null);
    if (!billingConfigured) {
      setUpgradeError("Chưa cấu hình tài khoản VietQR trên server.");
      return;
    }
    // Không chọn gói thì mặc định là gói thuê bao rẻ nhất đang bán (trừ Free).
    const target = planId
      || selectedPlanId
      || plans.find((plan) => plan.kind === "subscription" && plan.priceVnd > 0)?.id;
    if (!target) {
      setUpgradeError("Chưa có gói nào đang bán.");
      return;
    }
    setSelectedPlanId(target);
    setIsCreatingOrder(true);
    try {
      const response = await apiFetch("/api/billing/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: target }),
      });
      const body = await response.json().catch(() => null) as { order?: BillingOrder; error?: string } | null;
      if (!response.ok || !body?.order) throw new Error(body?.error || "Không tạo được đơn nâng cấp.");
      setUpgradeOrder(body.order);
    } catch (error) {
      setUpgradeOrder(null);
      setUpgradeError(error instanceof Error ? error.message : "Không tạo được đơn nâng cấp.");
    } finally {
      setIsCreatingOrder(false);
    }
  }, [billingConfigured, plans, selectedPlanId]);

  const recordingSupported = Boolean(
    typeof navigator.mediaDevices !== "undefined"
    && (supportedWebmMimeType() || typeof AudioContext !== "undefined"),
  );
  const forwardEntries = useMemo(() => entries.filter((entry) => entry.source === source), [entries, source]);
  const reverseEntries = useMemo(() => entries.filter((entry) => entry.source === target), [entries, target]);
  const textSizeIndex = TEXT_SIZES.indexOf(textSize);
  const transcriptionProvider = "STT";

  useEffect(() => {
    const viewport = window.visualViewport;
    let animationFrame = 0;

    const syncViewportHeight = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        const visibleHeight = viewport?.height || window.innerHeight;
        const visibleOffsetTop = viewport?.offsetTop || 0;
        document.documentElement.style.setProperty(
          "--app-viewport-height",
          `${Math.round(visibleHeight)}px`,
        );
        document.documentElement.style.setProperty(
          "--app-viewport-offset-top",
          `${Math.round(visibleOffsetTop)}px`,
        );
      });
    };

    syncViewportHeight();
    viewport?.addEventListener("resize", syncViewportHeight);
    viewport?.addEventListener("scroll", syncViewportHeight);
    window.addEventListener("resize", syncViewportHeight);
    window.addEventListener("orientationchange", syncViewportHeight);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      viewport?.removeEventListener("resize", syncViewportHeight);
      viewport?.removeEventListener("scroll", syncViewportHeight);
      window.removeEventListener("resize", syncViewportHeight);
      window.removeEventListener("orientationchange", syncViewportHeight);
      document.documentElement.style.removeProperty("--app-viewport-height");
      document.documentElement.style.removeProperty("--app-viewport-offset-top");
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      try {
        const response = await apiFetch("/api/health");
        const data = await response.json() as {
          configured?: boolean;
          transcriptionModel?: string;
          authRequired?: boolean;
          googleClientId?: string | null;
          billingConfigured?: boolean;
        };
        if (cancelled) return;
        setApiConfigured(Boolean(data.configured));
        if (data.transcriptionModel) setTranscriptionModel(data.transcriptionModel);
        setBillingConfigured(Boolean(data.billingConfigured));
        const needsAuth = Boolean(data.authRequired);
        setAuthRequired(needsAuth);
        setGoogleClientId(data.googleClientId || null);
        if (needsAuth) {
          // Hydrate session trước khi mở app, tránh nháy màn hình đăng nhập khi đã có cookie.
          const me = await apiFetch("/api/me");
          if (cancelled) return;
          if (me.ok) {
            const body = await me.json() as { user: AuthUser };
            if (!cancelled) setUser(body.user);
          }
        }
        if (!cancelled) setAuthReady(true);
      } catch {
        if (!cancelled) {
          setApiConfigured(false);
          setAuthReady(true);
        }
      }
    };
    void bootstrap();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!authReady || !authRequired || user || !googleClientId) return;
    let cancelled = false;
    let tries = 0;

    const handleCredential = async (response: { credential?: string }) => {
      const credential = response.credential?.trim();
      if (!credential) return;
      setAuthError(null);
      try {
        const result = await apiFetch("/api/auth/google", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credential }),
        });
        const body = await result.json().catch(() => null) as { user?: AuthUser; error?: string } | null;
        if (!result.ok || !body?.user) throw new Error(body?.error || "Đăng nhập Google thất bại.");
        setUser(body.user);
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : "Đăng nhập Google thất bại.");
      }
    };

    const renderButton = () => {
      if (cancelled || !googleButtonRef.current || !window.google?.accounts?.id) return;
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: handleCredential,
        ux_mode: "popup",
      });
      googleButtonRef.current.innerHTML = "";
      window.google.accounts.id.renderButton(googleButtonRef.current, {
        type: "standard",
        theme: "outline",
        size: "large",
        text: "signin_with",
        shape: "pill",
        width: 320,
      });
    };

    const ensureScriptAndRender = () => {
      if (cancelled) return;
      if (!googleButtonRef.current) {
        if (tries < 20) {
          tries += 1;
          window.setTimeout(ensureScriptAndRender, 50);
        }
        return;
      }
      const existing = document.querySelector<HTMLScriptElement>("script[data-google-gis]");
      if (window.google?.accounts?.id) {
        renderButton();
        return;
      }
      if (existing) {
        // Thẻ script trong index.html là async/defer: nếu nó đã tải xong (hoặc đang tải dở)
        // thì sự kiện load đã bắn trước khi effect này chạy.
        if (existing.dataset.loaded === "true") {
          renderButton();
          return;
        }
        existing.addEventListener("load", () => {
          existing.dataset.loaded = "true";
          renderButton();
        }, { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      script.dataset.googleGis = "true";
      script.addEventListener("load", renderButton, { once: true });
      document.head.appendChild(script);
    };

    ensureScriptAndRender();
    return () => { cancelled = true; };
  }, [authReady, authRequired, user, googleClientId]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const response = await apiFetch("/api/usage/heartbeat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ seconds: Math.round(USAGE_HEARTBEAT_MS / 1000) }),
          });
          const body = await response.json().catch(() => null) as {
            user?: AuthUser;
            error?: string;
            code?: string;
          } | null;
          if (body?.user) setUser(body.user);
          if (response.status === 402 || body?.code === "quota_exhausted") {
            setNotice(body?.error || "Đã hết hạn mức tháng này. Mua thêm để tiếp tục.");
            // Chỉ tự dừng và mở bảng mua khi đang trong phiên; lúc rảnh thì để người
            // dùng chủ động bấm, tránh modal bật lên mỗi 15 giây.
            if (sessionStatusRef.current === "running") {
              stopSessionRef.current();
              void openUpgrade();
            }
          }
        } catch {
          // Ignore transient heartbeat failures.
        }
      })();
    }, USAGE_HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [user?.id]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-100)));
    Object.values(panelScrollsRef.current).forEach((panel) => {
      panel?.scrollTo({ top: panel.scrollHeight, behavior: "smooth" });
    });
  }, [entries]);

  useEffect(() => {
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, textSize);
  }, [textSize]);

  // Ghi theme lên <html> để CSS đổi bảng màu; đổi theo OS khi chọn "system".
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(theme);
    };
    apply();
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    if (theme !== "system" || !media) return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(MOBILE_MERGED_VIEW_STORAGE_KEY, String(mobileMergedView));
  }, [mobileMergedView]);

  useEffect(() => {
    const settings: SavedSettings = { context, source, target, mode, voiceEnabled };
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Chế độ riêng tư / hết dung lượng: mất lựa chọn đã lưu nhưng app vẫn chạy.
    }
  }, [context, source, target, mode, voiceEnabled]);

  useEffect(() => {
    if (!mobileTextInputVisible) return;
    const animationFrame = window.requestAnimationFrame(() => mergedInputRef.current?.focus());
    return () => window.cancelAnimationFrame(animationFrame);
  }, [mobileTextInputVisible]);

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

  const translateEntry = useCallback(async (entry: ConversationEntry) => {
    const controller = new AbortController();
    controllersRef.current.set(entry.id, controller);

    try {
      const response = await apiFetch("/api/translate", {
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

      const body = (await response.json().catch(() => null)) as {
        translation?: string;
        error?: string;
        user?: AuthUser;
        code?: string;
      } | null;
      if (!response.ok) {
        // Hết hạn mức: mở bảng mua thêm thay vì chỉ báo lỗi khô khan.
        if (response.status === 402 || body?.code === "quota_exhausted") {
          if (body?.user) setUser(body.user);
          setNotice(body?.error || "Đã hết hạn mức. Mua thêm để tiếp tục dịch.");
          void openUpgrade();
        }
        throw new Error(body?.error || `Không thể dịch (HTTP ${response.status}).`);
      }
      // Server trừ hạn mức theo số ký tự; cập nhật lại badge mà không cần gọi /api/me.
      if (body?.user) setUser(body.user);
      const finalText = body?.translation?.trim() || "";
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

  const enqueueTranslation = useCallback((entry: ConversationEntry) => {
    const conversationEpoch = conversationEpochRef.current;
    translationQueueRef.current = translationQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (conversationEpoch !== conversationEpochRef.current) return;
        const waitMs = Math.max(
          0,
          MIN_TRANSLATION_INTERVAL_MS - (Date.now() - lastTranslationStartedAtRef.current),
        );
        if (waitMs) await new Promise((resolve) => window.setTimeout(resolve, waitMs));
        if (conversationEpoch !== conversationEpochRef.current) return;
        lastTranslationStartedAtRef.current = Date.now();
        await translateEntry(entry);
      });
  }, [translateEntry]);

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
    enqueueTranslation(entry);
  }, [activeLanguage, enqueueTranslation, source, target]);

  useEffect(() => {
    activeLanguageRef.current = activeLanguage;
  }, [activeLanguage]);

  useEffect(() => {
    sessionStatusRef.current = sessionStatus;
  }, [sessionStatus]);

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

      const response = await apiFetch("/api/transcribe", {
        method: "POST",
        body: form,
      });
      const body = (await response.json().catch(() => null)) as {
        text?: string;
        languageCode?: string;
        error?: string;
        code?: string;
        user?: AuthUser;
      } | null;
      if (!response.ok) {
        // Hết hạn mức: xử lý giống /api/translate để người dùng thấy nút mua thêm
        // thay vì một dòng lỗi không nói được phải làm gì.
        if (response.status === 402 || body?.code === "quota_exhausted") {
          if (body?.user) setUser(body.user);
          setNotice(body?.error || "Đã hết hạn mức. Mua thêm để tiếp tục nhận giọng nói.");
          stopSessionRef.current();
          void openUpgrade();
          return;
        }
        throw new Error(body?.error || `Không thể nhận giọng nói (HTTP ${response.status}).`);
      }
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

  const beginPcmSegment = useCallback(() => {
    if (!captureActiveRef.current || pcmSegmentSenderRef.current) return;
    if (transcriptionModel !== "soniox-stt") {
      setNotice("Chế độ ghi âm PCM cần dịch vụ STT realtime.");
      return;
    }

    const segmentId = makeId();
    const segmentLanguage = activeLanguageRef.current;
    const sessionSecond = elapsedRef.current;
    const conversationEpoch = conversationEpochRef.current;
    const languageHints = [segmentLanguage, source, target, ...Object.keys(LANGUAGES) as LanguageCode[]]
      .filter((language, index, values) => values.indexOf(language) === index);
    const socket = new WebSocket(realtimeWebSocketUrl());
    const pendingAudio = [...pcmPreRollRef.current];
    let socketOpened = false;
    let committed = false;
    let commitWhenOpen = false;
    let finished = false;
    let counted = false;
    let completionTimer: number | null = null;

    const cleanup = (errorMessage?: string) => {
      if (finished) return;
      finished = true;
      if (completionTimer !== null) window.clearTimeout(completionTimer);
      if (pcmSegmentSenderRef.current === sendAudio) pcmSegmentSenderRef.current = null;
      realtimeSocketsRef.current.delete(socket);
      setRealtimePartial((current) => current?.segmentId === segmentId ? null : current);
      if (counted) {
        counted = false;
        setTranscriptionCount((count) => Math.max(0, count - 1));
      }
      if (errorMessage) setNotice(errorMessage);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    };
    const flushAudio = () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      for (const audio of pendingAudio.splice(0)) {
        socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
      }
    };
    const sendCommit = () => {
      if (socket.readyState !== WebSocket.OPEN || finished) return;
      flushAudio();
      socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      completionTimer = window.setTimeout(() => {
        cleanup("Dịch vụ STT không trả về kết quả PCM kịp thời.");
      }, 25_000);
    };
    const sendAudio = (audio: string) => {
      if (finished || committed) return;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
      } else if (socket.readyState === WebSocket.CONNECTING) {
        pendingAudio.push(audio);
      }
    };

    pcmSegmentSenderRef.current = sendAudio;
    activeRealtimeSegmentRef.current = segmentId;
    setRealtimePartial(null);
    realtimeSocketsRef.current.add(socket);
    finishPcmSegmentRef.current = (transcribe) => {
      const isCurrentSegment = pcmSegmentSenderRef.current === sendAudio;
      if (isCurrentSegment) pcmSegmentSenderRef.current = null;
      speechDetectedRef.current = false;
      setIsSpeaking(false);
      if (!isCurrentSegment || finished) return;
      if (!transcribe) {
        cleanup();
        return;
      }
      committed = true;
      counted = true;
      setTranscriptionCount((count) => count + 1);
      if (socket.readyState === WebSocket.OPEN) sendCommit();
      else commitWhenOpen = true;
    };

    socket.onopen = () => {
      socketOpened = true;
      socket.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: PCM_SAMPLE_RATE },
              transcription: {
                model: "soniox-stt",
                languages: languageHints,
                ...(context.trim() ? { prompt: context.trim() } : {}),
              },
            },
          },
        },
      }));
      flushAudio();
      if (commitWhenOpen) sendCommit();
    };
    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(String(message.data)) as {
          type?: string;
          transcript?: string;
          tokens?: Array<{ language?: string }>;
          languages?: Array<{ code?: string } | string>;
          error?: { code?: string; message?: string };
        };
        if (event.type === "transcription.partial") {
          if (activeRealtimeSegmentRef.current !== segmentId) return;
          const tokenLanguage = event.tokens
            ?.map((token) => normalizeDetectedLanguage(token.language || ""))
            .reverse()
            .find((language): language is LanguageCode => Boolean(language));
          setRealtimePartial({
            segmentId,
            text: cleanRealtimeTranscript(event.transcript || ""),
            language: tokenLanguage && (tokenLanguage === source || tokenLanguage === target)
              ? tokenLanguage
              : segmentLanguage,
          });
        } else if (event.type === "conversation.item.input_audio_transcription.completed") {
          const transcript = cleanRealtimeTranscript(event.transcript || "");
          const detectedLanguages = (event.languages || []).map((language) => (
            typeof language === "string" ? language : language.code || ""
          ));
          if (transcript && conversationEpoch === conversationEpochRef.current) {
            routeTranscription(transcript, detectedLanguages, segmentLanguage, sessionSecond);
          }
          cleanup();
        } else if (event.type === "error") {
          if (event.error?.code === "quota_exhausted") {
            setShowUpgrade(true);
            stopSessionRef.current();
          }
          cleanup(event.error?.message || "Dịch vụ STT realtime trả về lỗi.");
        }
      } catch {
        cleanup("Dịch vụ STT realtime trả về dữ liệu không hợp lệ.");
      }
    };
    socket.onerror = () => cleanup("Không kết nối được tới dịch vụ STT realtime.");
    socket.onclose = () => {
      realtimeSocketsRef.current.delete(socket);
      if (!finished) cleanup(socketOpened && committed ? "Kết nối STT realtime đã đóng trước khi có kết quả." : undefined);
    };
  }, [context, routeTranscription, source, target, transcriptionModel]);

  const startSegment = useCallback(() => {
    const stream = mediaStreamRef.current;
    if (!stream || !captureActiveRef.current) return;
    const mimeType = supportedWebmMimeType();
    if (!mimeType) {
      setNotice("Safari trên iPhone này chưa hỗ trợ ghi âm WebM/Opus. Hãy cập nhật iOS lên phiên bản mới hơn.");
      return;
    }
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
            error?: { code?: string; message?: string };
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
            if (event.error?.code === "quota_exhausted") {
              setShowUpgrade(true);
              stopSessionRef.current();
            }
            socketFailure = event.error?.message || "Dịch vụ STT realtime trả về lỗi.";
            settle(null);
          }
        } catch {
          socketFailure = "Dịch vụ STT realtime trả về dữ liệu không hợp lệ.";
          settle(null);
        }
      };
      realtimeSocket.onerror = () => {
        socketFailure = "Không kết nối được tới dịch vụ STT realtime.";
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
        // Giữ header WebM và khoảng 2 giây pre-roll, không gửi thời gian im lặng dài lên dịch vụ STT.
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
    if (recorder?.state === "recording") {
      shouldTranscribeRef.current = transcribe && speechDetectedRef.current;
      setIsSpeaking(false);
      recorder.stop();
      return;
    }
    const shouldTranscribe = transcribe && speechDetectedRef.current;
    speechDetectedRef.current = false;
    setIsSpeaking(false);
    finishPcmSegmentRef.current(shouldTranscribe);
  }, []);

  const stopAudioCapture = useCallback((transcribePending = true) => {
    captureActiveRef.current = false;
    if (vadFrameRef.current !== null) window.clearInterval(vadFrameRef.current);
    vadFrameRef.current = null;
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === "recording") {
      shouldTranscribeRef.current = transcribePending && speechDetectedRef.current;
      recorder.stop();
    } else if (speechDetectedRef.current || pcmSegmentSenderRef.current) {
      finishPcmSegmentRef.current(transcribePending && speechDetectedRef.current);
    }
    pcmProcessorRef.current?.disconnect();
    if (pcmProcessorRef.current) pcmProcessorRef.current.onaudioprocess = null;
    pcmProcessorRef.current = null;
    pcmSinkRef.current?.disconnect();
    pcmSinkRef.current = null;
    pcmPreRollRef.current = [];
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    speechDetectedRef.current = false;
    setIsSpeaking(false);
    setIsListening(false);
    releaseWakeLock();
  }, [releaseWakeLock]);

  const startAudioCapture = useCallback(async () => {
    if (!recordingSupported) throw new Error("Trình duyệt chưa hỗ trợ truy cập và xử lý âm thanh từ micro.");

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const audioContext = new AudioContext();
    const sourceNode = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.35;
    sourceNode.connect(analyser);
    await audioContext.resume();

    mediaStreamRef.current = stream;
    audioContextRef.current = audioContext;
    captureActiveRef.current = true;
    setIsListening(true);
    void requestWakeLock();
    if (supportedWebmMimeType()) {
      startSegmentRef.current();
    } else {
      const processor = audioContext.createScriptProcessor(4_096, 1, 1);
      const sink = audioContext.createGain();
      sink.gain.value = 0;
      processor.onaudioprocess = (event) => {
        if (!captureActiveRef.current) return;
        const audio = encodePcm16Base64(event.inputBuffer.getChannelData(0), audioContext.sampleRate);
        pcmPreRollRef.current.push(audio);
        if (pcmPreRollRef.current.length > PCM_PRE_ROLL_CHUNKS) pcmPreRollRef.current.shift();
        if (speechDetectedRef.current) pcmSegmentSenderRef.current?.(audio);
      };
      sourceNode.connect(processor);
      processor.connect(sink);
      sink.connect(audioContext.destination);
      pcmProcessorRef.current = processor;
      pcmSinkRef.current = sink;
      beginRealtimeRef.current = beginPcmSegment;
    }

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
    };
    // Dùng setInterval thay vì requestAnimationFrame: rAF bị treo khi tab bị ẩn hoặc
    // màn hình khoá, khiến phiên dịch đứng im mà không báo lỗi. Interval vẫn chạy khi ẩn.
    vadFrameRef.current = window.setInterval(monitorVoice, VAD_INTERVAL_MS);
  }, [beginPcmSegment, finishSegment, recordingSupported]);

  // Trình duyệt nhả wake lock khi tab bị ẩn; quay lại thì xin lại nếu phiên còn chạy.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && wakeLockWantedRef.current) void requestWakeLock();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [requestWakeLock]);

  useEffect(() => () => {
    controllersRef.current.forEach((controller) => controller.abort());
    realtimeSocketsRef.current.forEach((socket) => socket.close());
    realtimeSocketsRef.current.clear();
    window.speechSynthesis?.cancel();
    stopAudioCapture(false);
  }, [stopAudioCapture]);

  const startSession = async () => {
    if (user && !user.unlimited && (user.remainingSeconds ?? 0) <= 0) {
      setNotice("Đã hết thời gian miễn phí. Hãy nâng cấp để tiếp tục.");
      setShowUpgrade(true);
      return;
    }
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
    startedAtRef.current = null;
    setSessionStatus("idle");
    stopAudioCapture(true);
    elapsedBeforePauseRef.current = 0;
    elapsedRef.current = 0;
    setElapsed(0);
  };

  useEffect(() => {
    stopSessionRef.current = stopSession;
  });

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
    translationQueueRef.current = Promise.resolve();
    lastTranslationStartedAtRef.current = 0;
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

  const removeEntry = (id: string) => {
    controllersRef.current.get(id)?.abort();
    controllersRef.current.delete(id);
    setEntries((current) => current.filter((entry) => entry.id !== id));
  };

  const logout = async () => {
    stopSessionRef.current();
    setShowAccountMenu(false);
    await apiFetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    setUpgradeOrder(null);
    setShowUpgrade(false);
  };

  useEffect(() => {
    if (!showAccountMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".account-controls")) setShowAccountMenu(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [showAccountMenu]);

  const renderAccountControls = (placement: "top" | "desktop" = "top") => {
    if (!user) return null;
    return (
      <div className={`account-controls account-controls-${placement}`}>
        <button
          type="button"
          className={`quota-badge ${user.plan === "pro" ? "pro" : "free"} ${quotaWarning !== "none" ? "warn" : ""}`}
          onClick={() => void openUpgrade()}
          title={
            user.unlimited
              ? "Không giới hạn"
              : `${formatRemaining(user.remainingSeconds, user.unlimited)} còn lại${
                user.periodResetsAt ? ` · làm mới ${new Date(user.periodResetsAt).toLocaleDateString("vi-VN")}` : ""
              }`
          }
        >
          <span>{user.planName || (user.plan === "pro" ? "Pro" : "Free")}</span>
          <strong>{formatRemaining(user.remainingSeconds, user.unlimited)}</strong>
        </button>
        <div className="account-menu-wrap">
          <button
            type="button"
            className={`account-avatar-button ${showAccountMenu ? "open" : ""}`}
            onClick={() => setShowAccountMenu((open) => !open)}
            aria-label="Tài khoản"
            aria-expanded={showAccountMenu}
          >
            {user.picture
              ? <img src={user.picture} alt="" />
              : <span>{(user.name || user.email || "?").slice(0, 1).toUpperCase()}</span>}
          </button>
          {showAccountMenu ? (
            <div className="account-menu" role="menu">
              <div className="account-menu-head">
                <strong>{user.name || "Người dùng"}</strong>
                <small>{user.email}</small>
              </div>
              <button type="button" role="menuitem" onClick={() => { setShowAccountMenu(false); void openUpgrade(); }}>
                {user.plan === "pro" ? "Mua thêm thời gian" : "Nâng cấp / mua thêm"}
              </button>
              <button type="button" role="menuitem" className="danger" onClick={() => void logout()}>
                Đăng xuất
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  // Tải danh sách gói một lần khi đã đăng nhập, để mở modal nâng cấp là có sẵn.
  useEffect(() => {
    if (!user) return;
    void (async () => {
      const response = await apiFetch("/api/plans");
      if (!response.ok) return;
      const body = await response.json() as { plans: BillingPlan[] };
      setPlans(body.plans);
    })();
  }, [user?.id]);

  // Cảnh báo sớm theo hạn mức còn lại: 5 phút → banner, 1 phút → rung + thông báo.
  useEffect(() => {
    if (!user || user.unlimited || user.remainingSeconds === null) {
      setQuotaWarning("none");
      return;
    }
    const next = user.remainingSeconds <= QUOTA_CRITICAL_SECONDS
      ? "critical"
      : user.remainingSeconds <= QUOTA_WARN_SECONDS
        ? "low"
        : "none";
    setQuotaWarning((previous) => {
      // Chỉ báo đúng một lần khi vừa vượt ngưỡng, tránh rung lặp lại mỗi lần heartbeat.
      if (next === "critical" && previous !== "critical") {
        navigator.vibrate?.([120, 60, 120]);
        setNotice("Chỉ còn dưới 1 phút hạn mức. Phiên sẽ tự dừng khi hết — bấm để mua thêm.");
      }
      return next;
    });
  }, [user?.remainingSeconds, user?.unlimited]);

  useEffect(() => {
    if (!showUpgrade || !upgradeOrder || upgradeOrder.status !== "pending") return;
    const timer = window.setInterval(() => {
      void (async () => {
        const response = await apiFetch(`/api/billing/orders/${upgradeOrder.id}`);
        if (!response.ok) return;
        const body = await response.json() as { order: BillingOrder };
        setUpgradeOrder(body.order);
        if (body.order.status === "paid") {
          const me = await apiFetch("/api/me");
          if (me.ok) {
            const meBody = await me.json() as { user: AuthUser };
            setUser(meBody.user);
          }
          setNotice("Thanh toán thành công — hạn mức đã được nâng cấp.");
        }
      })();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [showUpgrade, upgradeOrder?.id, upgradeOrder?.status]);

  const generateSummary = async () => {
    if (!entries.length) return;
    setShowSummary(true);
    setIsSummarizing(true);
    setSummary("");
    try {
      const response = await apiFetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries, outputLanguage: "vi", context }),
      });
      const body = (await response.json()) as { summary?: string; error?: string; user?: AuthUser; code?: string };
      if (!response.ok || !body.summary) {
        if (response.status === 402 || body.code === "quota_exhausted") {
          if (body.user) setUser(body.user);
          setShowSummary(false);
          setNotice(body.error || "Đã hết hạn mức. Mua thêm để tạo biên bản.");
          void openUpgrade();
        }
        throw new Error(body.error || "Không thể tạo biên bản.");
      }
      if (body.user) setUser(body.user);
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

      <div
        className="transcript-scroll"
        aria-live="polite"
        ref={(node) => { panelScrollsRef.current[panelKey] = node; }}
      >
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
            <button
              className="delete-entry"
              type="button"
              onClick={() => removeEntry(entry.id)}
              aria-label={`Xóa đoạn hội thoại lúc ${formatEntryTime(entry.sessionSecond)}`}
              title="Xóa đoạn hội thoại này"
            >
              <Icon name="trash" />
            </button>
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

  const renderMergedPanel = () => (
    <section className="transcript-panel merged-transcript-panel">
      <div
        className="transcript-scroll merged-transcript-scroll"
        aria-live="polite"
        ref={(node) => { panelScrollsRef.current.merged = node; }}
      >
        {entries.length === 0 && !realtimePartial && !isSpeaking && transcriptionCount === 0 ? (
          <div className="panel-empty">
            <span><Icon name="mic" /></span>
            <strong>Chưa có nội dung</strong>
            <p>Chọn người đang nói và bắt đầu phiên dịch.</p>
          </div>
        ) : entries.map((entry) => (
          <article className="transcript-entry merged-entry" key={entry.id}>
            <button
              className="delete-entry"
              type="button"
              onClick={() => removeEntry(entry.id)}
              aria-label={`Xóa đoạn hội thoại lúc ${formatEntryTime(entry.sessionSecond)}`}
              title="Xóa đoạn hội thoại này"
            >
              <Icon name="trash" />
            </button>
            <p className="original-text" lang={entry.source}>{entry.sourceText}</p>
            <p className={`translated-text ${entry.status}`} lang={entry.target}>
              {entry.translation || <span className="typing"><i /><i /><i /></span>}
            </p>
          </article>
        ))}

        {realtimePartial ? (
          <article className="transcript-entry interim realtime-partial merged-realtime-partial">
            <time>{isSpeaking ? "TRỰC TIẾP" : "ĐANG HOÀN TẤT"}</time>
            <p className="original-text" lang={realtimePartial.language}>{realtimePartial.text || "Đang nghe…"}</p>
          </article>
        ) : isSpeaking ? (
          <article className="transcript-entry interim">
            <time>ĐANG GHI · {LANGUAGES[activeLanguage].short}</time>
            <p className="original-text">Đang nghe và nhận dạng trực tiếp…</p>
          </article>
        ) : transcriptionCount > 0 && (
          <article className="transcript-entry transcribing">
            <time>{transcriptionProvider.toUpperCase()}</time>
            <p className="original-text">Đang nhận dạng giọng nói…</p>
          </article>
        )}
      </div>

      {mobileTextInputVisible && (
        <form
          className="panel-input merged-panel-input"
          onSubmit={(event) => {
            handleSubmit(event, activeLanguage);
            setMobileTextInputVisible(false);
          }}
        >
          <input
            ref={mergedInputRef}
            id="message-merged"
            name="message-merged"
            value={manualText[activeLanguage]}
            onChange={(event) => setManualText((current) => ({ ...current, [activeLanguage]: event.target.value }))}
            placeholder={`Nhập bằng ${LANGUAGES[activeLanguage].name} để thử…`}
            maxLength={4000}
          />
          <button type="submit" disabled={!manualText[activeLanguage].trim()} aria-label={`Dịch từ ${LANGUAGES[activeLanguage].name}`}>
            <Icon name="send" />
          </button>
        </form>
      )}
    </section>
  );

  if (!authReady) {
    return (
      <div className="access-gate">
        <div className="access-stage">
          <span className="brand-mark"><Icon name="spark" /></span>
          <p className="access-kicker">Relay</p>
          <p className="access-loading">Đang mở phiên…</p>
        </div>
      </div>
    );
  }

  if (authRequired && !user) {
    return (
      <div className="access-gate">
        <div className="access-stage">
          <span className="brand-mark"><Icon name="spark" /></span>
          <p className="access-kicker">AI Interpreter</p>
          <h1>Relay</h1>
          <p className="access-lead">Phiên dịch hội thoại trực tiếp. Dùng thử 30 phút miễn phí sau khi đăng nhập Google.</p>
          {!googleClientId ? (
            <p className="access-error">Server chưa cấu hình GOOGLE_CLIENT_ID.</p>
          ) : (
            <div className="google-button-slot" ref={googleButtonRef} />
          )}
          {authError ? <p className="access-error">{authError}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className={`app-shell text-size-${textSize} ${mobileHeaderCollapsed ? "mobile-header-collapsed" : ""} ${mobileMergedView ? "mobile-merged-view" : ""}`}>
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
          {renderAccountControls("top")}
          <button
            className="danger-action clear-all-action"
            onClick={clearConversation}
            disabled={!entries.length}
            aria-label="Xóa toàn bộ hội thoại"
            title="Xóa toàn bộ hội thoại"
          >
            <Icon name="trash" />
            <span>Xóa tất cả</span>
          </button>
          <button onClick={() => setShowSettings(true)} aria-label="Cài đặt" title="Cài đặt"><Icon name="settings" /></button>
        </div>
      </header>

      <main className="session-shell">
        <header className="desktop-workspace-header">
          <div className="desktop-brand">
            <span className="brand-mark"><Icon name="spark" /></span>
            <strong>Relay</strong>
          </div>

          <nav className="desktop-mode-tabs" aria-label="Chế độ phiên dịch">
            <button className={mode === "one-way" ? "active" : ""} onClick={() => { setMode("one-way"); switchSpeaker(source); }}>Một chiều</button>
            <button className={mode === "two-way" ? "active" : ""} onClick={() => setMode("two-way")}>Hai chiều</button>
          </nav>

          <div className="desktop-language-pair">
            <select aria-label="Ngôn ngữ nguồn" value={source} onChange={(event) => changeSource(event.target.value as LanguageCode)}>
              {(Object.keys(LANGUAGES) as LanguageCode[]).map((code) => <option key={code} value={code}>{LANGUAGES[code].name}</option>)}
            </select>
            <button onClick={swapLanguages} aria-label="Đổi ngôn ngữ"><Icon name="swap" /></button>
            <select aria-label="Ngôn ngữ đích" value={target} onChange={(event) => changeTarget(event.target.value as LanguageCode)}>
              {(Object.keys(LANGUAGES) as LanguageCode[]).map((code) => <option key={code} value={code}>{LANGUAGES[code].name}</option>)}
            </select>
          </div>

          <div className="desktop-transport">
            {sessionStatus === "running" ? (
              <button className="desktop-control primary" onClick={pauseSession} aria-label="Tạm dừng"><Icon name="pause" /></button>
            ) : (
              <button
                className="desktop-control primary"
                onClick={() => void startSession()}
                aria-label={sessionStatus === "paused" ? "Tiếp tục ghi âm" : "Bắt đầu ghi âm"}
                title={sessionStatus === "paused" ? "Tiếp tục ghi âm" : "Bắt đầu ghi âm"}
              >
                <Icon name={sessionStatus === "paused" ? "play" : "mic"} />
              </button>
            )}
            <button className="desktop-control" onClick={stopSession} disabled={sessionStatus === "idle" && elapsed === 0} aria-label="Kết thúc"><Icon name="stop" /></button>
          </div>

          <time className="desktop-time">{formatTime(elapsed)}</time>

          <div className="desktop-actions">
            {renderAccountControls("desktop")}
            <button className={voiceEnabled ? "active" : ""} onClick={() => setVoiceEnabled((value) => !value)} aria-label="Phát giọng dịch" title="Phát giọng dịch"><Icon name={voiceEnabled ? "volume" : "volumeOff"} /></button>
            <button onClick={exportTranscript} disabled={!entries.length} aria-label="Tải transcript" title="Tải transcript"><Icon name="download" /></button>
            <button onClick={() => void generateSummary()} disabled={!entries.length} aria-label="Biên bản AI" title="Biên bản AI"><Icon name="notes" /></button>
            <button className="danger-action" onClick={clearConversation} disabled={!entries.length} aria-label="Xóa toàn bộ hội thoại" title="Xóa toàn bộ hội thoại"><Icon name="trash" /></button>
            <button onClick={() => setShowSettings(true)} aria-label="Cài đặt" title="Cài đặt"><Icon name="settings" /></button>
          </div>
        </header>

        <section className="session-controls">
          <div className="audio-source">
            <span className={`source-icon ${isListening ? "live" : ""}`}><Icon name="mic" /></span>
            <div><small>Nguồn âm thanh</small><strong>Microphone</strong></div>
          </div>

          <div className="transport">
            {sessionStatus === "running" ? (
              <button className="control-button pause" onClick={pauseSession} aria-label="Tạm dừng"><Icon name="pause" /></button>
            ) : (
              <button
                className="control-button play"
                onClick={() => void startSession()}
                aria-label={sessionStatus === "paused" ? "Tiếp tục ghi âm" : "Bắt đầu ghi âm"}
                title={sessionStatus === "paused" ? "Tiếp tục ghi âm" : "Bắt đầu ghi âm"}
              >
                <Icon name={sessionStatus === "paused" ? "play" : "mic"} />
              </button>
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

          <button
            className="mobile-collapse-action"
            type="button"
            onClick={() => setMobileHeaderCollapsed(true)}
            aria-label="Thu gọn phần điều khiển"
            aria-expanded="true"
            title="Thu gọn phần điều khiển"
          >
            <Icon name="chevron" />
          </button>
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
            {mode === "two-way" && mobileMergedView && (
              <button
                className={`merged-input-toggle ${mobileTextInputVisible ? "active" : ""}`}
                type="button"
                onClick={() => setMobileTextInputVisible((visible) => !visible)}
                aria-label={mobileTextInputVisible ? "Ẩn ô nhập" : "Hiện ô nhập"}
                aria-expanded={mobileTextInputVisible}
                title={mobileTextInputVisible ? "Ẩn ô nhập" : "Nhập bằng bàn phím"}
              >
                <Icon name={mobileTextInputVisible ? "close" : "keyboard"} />
              </button>
            )}
          </div>

          <div className="toolbar-right">
            <div className="text-size-control" aria-label="Cỡ chữ transcript">
              <span>Cỡ chữ</span>
              <button onClick={() => adjustTextSize(-1)} disabled={textSizeIndex === 0} aria-label="Thu nhỏ chữ">A−</button>
              <output aria-live="polite">{TEXT_SIZE_LABELS[textSize]}</output>
              <button onClick={() => adjustTextSize(1)} disabled={textSizeIndex === TEXT_SIZES.length - 1} aria-label="Phóng to chữ">A+</button>
            </div>
          </div>
        </section>

        <section className="mobile-compact-header" aria-label="Điều khiển phiên dịch thu gọn">
          <div className={`compact-language-pair ${isListening ? "live" : ""}`} title={`${LANGUAGES[source].name} sang ${LANGUAGES[target].name}`}>
            <span>{LANGUAGES[source].short}</span>
            <Icon name="chevron" />
            <span>{LANGUAGES[target].short}</span>
          </div>

          <div className="compact-transport">
            {sessionStatus === "running" ? (
              <button className="compact-control primary" onClick={pauseSession} aria-label="Tạm dừng"><Icon name="pause" /></button>
            ) : (
              <button
                className="compact-control primary"
                onClick={() => void startSession()}
                aria-label={sessionStatus === "paused" ? "Tiếp tục ghi âm" : "Bắt đầu ghi âm"}
                title={sessionStatus === "paused" ? "Tiếp tục ghi âm" : "Bắt đầu ghi âm"}
              >
                <Icon name={sessionStatus === "paused" ? "play" : "mic"} />
              </button>
            )}
            <button className="compact-control" onClick={stopSession} disabled={sessionStatus === "idle" && elapsed === 0} aria-label="Kết thúc"><Icon name="stop" /></button>
          </div>

          <time>{formatTime(elapsed)}</time>
          {mode === "two-way" && mobileMergedView && (
            <button
              className={`compact-input-toggle ${mobileTextInputVisible ? "active" : ""}`}
              type="button"
              onClick={() => setMobileTextInputVisible((visible) => !visible)}
              aria-label={mobileTextInputVisible ? "Ẩn ô nhập" : "Hiện ô nhập"}
              aria-expanded={mobileTextInputVisible}
              title={mobileTextInputVisible ? "Ẩn ô nhập" : "Nhập bằng bàn phím"}
            >
              <Icon name={mobileTextInputVisible ? "close" : "keyboard"} />
            </button>
          )}
          <button
            className="mobile-expand-action"
            type="button"
            onClick={() => setMobileHeaderCollapsed(false)}
            aria-label="Mở rộng phần điều khiển"
            aria-expanded="false"
            title="Mở rộng phần điều khiển"
          >
            <Icon name="chevron" />
          </button>
        </section>

        {notice && <div className="notice" role="alert"><span>!</span>{notice}<button onClick={() => setNotice(null)}>×</button></div>}

        {quotaWarning !== "none" && user && !user.unlimited ? (
          <div className={`quota-warning ${quotaWarning}`} role="status">
            <span>
              <strong>
                {quotaWarning === "critical" ? "Sắp hết hạn mức" : "Hạn mức sắp hết"}
              </strong>
              {" · còn "}
              {formatRemaining(user.remainingSeconds, false)}
              {quotaWarning === "critical"
                ? " — phiên sẽ tự dừng."
                : " — mua thêm để không gián đoạn."}
            </span>
            <button type="button" onClick={() => void openUpgrade()}>Mua thêm</button>
          </div>
        ) : null}

        <div className={`transcript-grid ${mode}`}>
          {renderPanel(source, target, forwardEntries, "forward")}
          {mode === "two-way" && renderPanel(target, source, reverseEntries, "reverse")}
          {mode === "two-way" && renderMergedPanel()}
        </div>

        <footer className="session-footer">
          <span><i className={sessionStatus === "running" ? "online" : ""} />{
            transcriptionCount > 0
              ? `${transcriptionProvider} đang xử lý ${transcriptionCount} đoạn âm thanh`
              : sessionStatus === "running"
                ? `${isSpeaking ? "Đang ghi âm" : "Đang chờ giọng nói"} · ${LANGUAGES[activeLanguage].name}`
                : "Sẵn sàng bắt đầu"
          }</span>
          <span>WebM/Opus · STT · AI translation</span>
        </footer>
      </main>

      {showUpgrade && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowUpgrade(false)}>
          <section className="modal-card upgrade-modal" role="dialog" aria-modal="true" aria-labelledby="upgrade-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span className="modal-icon"><Icon name="spark" /></span>
                <div>
                  <h2 id="upgrade-title">Mua thời gian sử dụng</h2>
                  <p>Chọn gói rồi quét VietQR — hạn mức tự cộng sau khi chuyển khoản.</p>
                </div>
              </div>
              <button onClick={() => setShowUpgrade(false)} aria-label="Đóng"><Icon name="close" /></button>
            </header>
            <div className="upgrade-body">
              {upgradeError ? <p className="access-error">{upgradeError}</p> : null}

              {!upgradeOrder && plans.length ? (
                <div className="plan-grid">
                  {plans.filter((plan) => plan.priceVnd > 0).map((plan) => {
                    const active = selectedPlanId === plan.id;
                    return (
                      <button
                        type="button"
                        key={plan.id}
                        className={`plan-card ${active ? "active" : ""}`}
                        onClick={() => void openUpgrade(plan.id)}
                        disabled={isCreatingOrder}
                      >
                        <span className="plan-card-kind">{plan.kind === "event" ? "Một lần" : "Hằng tháng"}</span>
                        <strong>{plan.name}</strong>
                        <span className="plan-card-price">{formatVnd(plan.priceVnd)}</span>
                        <small>
                          {plan.kind === "subscription"
                            ? `+${formatRemaining(plan.monthlySeconds, plan.monthlySeconds === 0)} mỗi tháng`
                            : `+${formatRemaining(plan.durationSeconds, false)} dùng một lần`}
                        </small>
                        <em>{plan.description}</em>
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {isCreatingOrder ? <p className="upgrade-loading">Đang tạo mã QR…</p> : null}
              {upgradeOrder ? (
                <>
                  <p className="upgrade-plan-label">
                    Gói đã chọn: <strong>{upgradeOrder.planName || upgradeOrder.planId}</strong>
                  </p>
                  <img className="upgrade-qr" src={upgradeOrder.qrImageUrl} alt={`VietQR ${upgradeOrder.transferCode}`} />
                  <div className="upgrade-meta">
                    <p><strong>Số tiền:</strong> {formatVnd(upgradeOrder.amountVnd)}</p>
                    <p><strong>Nội dung CK:</strong> <code>{upgradeOrder.transferCode}</code></p>
                    <p><strong>Thụ hưởng:</strong> {upgradeOrder.bankAccountName} · {upgradeOrder.bankAccount}</p>
                    <p className={`upgrade-status status-${upgradeOrder.status}`}>
                      {upgradeOrder.status === "pending" && "Đang chờ thanh toán…"}
                      {upgradeOrder.status === "paid" && "Đã thanh toán — hạn mức đã cập nhật."}
                      {upgradeOrder.status === "expired" && "Đơn đã hết hạn. Tạo đơn mới để tiếp tục."}
                    </p>
                  </div>
                  {upgradeOrder.status === "expired" ? (
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => void openUpgrade(upgradeOrder.planId || undefined)}
                    >
                      Tạo QR mới
                    </button>
                  ) : null}
                  {upgradeOrder.status === "paid" ? (
                    <button type="button" className="primary-button" onClick={() => setShowUpgrade(false)}>Tiếp tục dùng</button>
                  ) : null}
                  {upgradeOrder.status === "pending" ? (
                    <button type="button" className="upgrade-other-plan" onClick={() => setUpgradeOrder(null)}>
                      Chọn gói khác
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
          </section>
        </div>
      )}

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
            <div className="text-size-setting">
              <span><strong>Giao diện</strong><small>{theme === "system" ? "Đang theo cài đặt hệ điều hành" : "Đã chọn cố định"}</small></span>
              <div>
                <button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}>Sáng</button>
                <button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}>Tối</button>
                <button className={theme === "system" ? "active" : ""} onClick={() => setTheme("system")}>Tự động</button>
              </div>
            </div>
            <label className="toggle-row"><span><strong>Gộp hội thoại trên mobile</strong><small>Hiển thị hai chiều trong một luồng theo thời gian</small></span><input type="checkbox" checked={mobileMergedView} onChange={(event) => setMobileMergedView(event.target.checked)} /></label>
            <label className="toggle-row"><span><strong>Phát giọng bản dịch</strong><small>Đọc bản dịch sau mỗi câu hoàn chỉnh</small></span><input type="checkbox" checked={voiceEnabled} onChange={(event) => setVoiceEnabled(event.target.checked)} /></label>
            {user ? (
              <div className="account-settings-row">
                <span>
                  <strong>{user.email}</strong>
                  <small>{user.plan === "pro" ? "Gói Pro" : "Gói Free"} · còn {formatRemaining(user.remainingSeconds, user.unlimited)}</small>
                </span>
                <div>
                  {user.plan !== "pro" ? (
                    <button type="button" onClick={() => { setShowSettings(false); void openUpgrade(); }}>Nâng cấp</button>
                  ) : null}
                  <button type="button" className="logout-settings" onClick={() => void logout()}>Đăng xuất</button>
                </div>
              </div>
            ) : null}
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
