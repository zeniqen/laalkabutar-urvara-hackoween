"use client";

/**
 * Voice-first conversation with Urvara. The farmer speaks (Sarvam STT) or
 * types; Urvara replies from their own records (Ollama Cloud, with the
 * rule-based answer as ground truth and fallback) and reads it aloud (Sarvam
 * TTS). When a message sounds like a report for the owner, Urvara offers it
 * as a card the farmer confirms or corrects; nothing is saved without that.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, LoaderCircle, Mic, PencilLine, RotateCcw, SendHorizontal, Sparkles, Square, Volume2, X } from "lucide-react";
import type { Language, ReportKind, UrvaraState, User } from "@/types";
import { useReadyState } from "@/components/providers/UrvaraProvider";
import { Provenance } from "@/components/ui/domain";
import { Button, Chip, TextInput } from "@/components/ui/primitives";
import { cropLabel } from "@/data/crops";
import { pick, tr, type I18nKey } from "@/lib/i18n";
import { tx } from "@/lib/i18n-farmer-extra";
import { parseUtterance } from "@/services/intent";
import { answerQuestion, type AssistantAnswer } from "@/services/assistant";
import { buildReplyFacts, MAX_TURNS, type ChatTurn } from "@/services/replyContext";
import { matchCompletionTask, submitReport } from "@/services/reports";
import { askAssistant } from "./assistantClient";
import { KIND_ICON, ModeTag, Review, type Details, type InputMode } from "./ReportReview";
import {
  MAX_CLIP_SECONDS,
  detectSpeechEngine,
  getReadAloud,
  speakAloud,
  speechRecognitionSupported,
  startCloudListening,
  startListening,
  stopSpeaking,
  unlockAudio,
  type SpeechEngine,
  type SpeechErrorKind,
  type SpeechSession,
} from "./speech";

const CHAT_KEY = "urvara:farmer-chat";

const SAMPLES: Record<Language, string[]> = {
  en: [
    "My tomato leaves have yellow spots.",
    "I finished irrigation in Field 2.",
    "We need another sprayer tomorrow.",
    "When will the tractor reach my farm?",
    "Should we irrigate today?",
  ],
  hi: [
    "टमाटर की पत्तियों पर पीले धब्बे हैं",
    "खेत 2 में सिंचाई पूरी हो गई",
    "कल एक और स्प्रेयर चाहिए",
    "ट्रैक्टर मेरे खेत पर कब आएगा?",
    "क्या आज सिंचाई करनी चाहिए?",
  ],
  pa: [
    "ਟਮਾਟਰ ਦੇ ਪੱਤਿਆਂ ਤੇ ਪੀਲੇ ਧੱਬੇ ਹਨ",
    "ਖੇਤ 2 ਵਿੱਚ ਸਿੰਚਾਈ ਪੂਰੀ ਹੋ ਗਈ",
    "ਕੱਲ੍ਹ ਇੱਕ ਹੋਰ ਸਪਰੇਅਰ ਚਾਹੀਦਾ ਹੈ",
    "ਟਰੈਕਟਰ ਮੇਰੇ ਖੇਤ ਕਦੋਂ ਆਵੇਗਾ?",
    "ਕੀ ਅੱਜ ਸਿੰਚਾਈ ਕਰਨੀ ਚਾਹੀਦੀ ਹੈ?",
  ],
};

/** Kinds worth offering to the owner as a report. Questions only when neither the AI nor the rules could answer. */
const OFFERED: ReportKind[] = ["problem", "completion", "resource_request"];

interface Offer {
  text: string;
  mode: InputMode;
  details: Details;
  status: "offered" | "editing" | "sent";
}

interface Message {
  id: string;
  role: "farmer" | "urvara";
  text: string;
  mode?: InputMode;
  by?: "ai" | "rules";
  sources?: AssistantAnswer["sources"];
  offer?: Offer;
}

type Voice = "idle" | "recording" | "processing";
type Playback = Awaited<ReturnType<typeof speakAloud>> | "loading";

function loadChat(): Message[] {
  try {
    const raw = window.sessionStorage.getItem(CHAT_KEY);
    return raw ? (JSON.parse(raw) as Message[]) : [];
  } catch {
    return [];
  }
}

function saveChat(messages: Message[]) {
  try {
    if (messages.length) window.sessionStorage.setItem(CHAT_KEY, JSON.stringify(messages));
    else window.sessionStorage.removeItem(CHAT_KEY);
  } catch {
    /* storage unavailable; the conversation still lives in component state */
  }
}

const newId = () => Math.random().toString(36).slice(2, 10);

function understood(details: Details, state: UrvaraState): string {
  const field = state.fields.find((f) => f.id === details.fieldId);
  return [
    `${details.kind.replace("_", " ")}${field ? ` about ${field.name} (${cropLabel(field.crop)})` : ""}`,
    details.kind === "problem" && details.symptom ? `symptom: ${details.symptom}, severity ${details.severity}` : "",
    details.kind === "resource_request" && details.requestedResource ? `needs: ${details.requestedResource}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function Conversation() {
  const { state, user, run } = useReadyState();
  const lang = user.language;
  const t = (k: I18nKey) => tr(lang, k);
  const myFields = state.fields.filter((f) => user.fieldIds.includes(f.id));

  const [messages, setMessages] = useState<Message[]>(loadChat);
  const [draft, setDraft] = useState("");
  const [voice, setVoice] = useState<Voice>("idle");
  const [liveText, setLiveText] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<SpeechErrorKind | null>(null);
  const [thinking, setThinking] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [playing, setPlaying] = useState<{ id: string; status: Playback } | null>(null);
  // Rendered only client-side (behind PortalGate), so feature detection can run in the initializer.
  const [engine, setEngine] = useState<SpeechEngine>(() => (speechRecognitionSupported() ? "browser" : "none"));
  const session = useRef<SpeechSession | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void detectSpeechEngine().then((e) => live && setEngine(e));
    return () => {
      live = false;
      session.current?.abort();
      stopSpeaking();
    };
  }, []);

  useEffect(() => saveChat(messages), [messages]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, thinking, voice]);

  function play(id: string, text: string) {
    unlockAudio();
    setPlaying({ id, status: "loading" });
    void speakAloud(text, lang).then((status) => setPlaying({ id, status }));
  }

  function patchOffer(id: string, patch: Partial<Offer>) {
    setMessages((list) => list.map((m) => (m.id === id && m.offer ? { ...m, offer: { ...m.offer, ...patch } } : m)));
  }

  async function send(text: string, mode: InputMode) {
    const words = text.trim();
    if (!words || thinking) return;
    unlockAudio(); // typed and sample sends are taps; voice sends were unlocked at the mic tap
    setError(null);
    setDraft("");
    const farmerMsg: Message = { id: newId(), role: "farmer", text: words, mode };
    const history = [...messages, farmerMsg];
    setMessages(history);
    setThinking(true);

    const parsed = parseUtterance(words, myFields);
    const field = myFields.find((f) => f.id === parsed.fieldId) ?? myFields[0];
    const details: Details = {
      kind: parsed.kind,
      fieldId: field?.id ?? "",
      symptom: parsed.symptom ?? "",
      severity: parsed.severity,
      requestedResource: parsed.requestedResource ?? "",
      taskType: parsed.taskType,
    };
    const rule =
      parsed.kind === "question" && field ? answerQuestion(state, user, { ...parsed, fieldId: field.id }, lang) : undefined;
    const turns: ChatTurn[] = history
      .slice(-MAX_TURNS)
      .map((m) => ({ role: m.role === "farmer" ? "user" : "assistant", content: m.text }));
    const aiText = await askAssistant({
      language: lang,
      messages: turns,
      facts: buildReplyFacts(state, user, field?.id),
      // Only a real rule-based answer is ground truth; "I've sent it to the owner" must not stop the model answering.
      // Name a field only when the farmer did; a defaulted field pulls unrelated answers towards it.
      hint: { kind: parsed.kind, understood: parsed.fieldId || parsed.crop ? understood(details, state) : "", draftAnswer: rule && !rule.forwarded ? rule.text : undefined },
    });

    const offerIt = field && (OFFERED.includes(parsed.kind) || (parsed.kind === "question" && !aiText && rule?.forwarded));
    const reply: Message = {
      id: newId(),
      role: "urvara",
      text: aiText ?? rule?.text ?? tx(lang, offerIt ? "chatNotedOffer" : "chatNoAi"),
      by: aiText ? "ai" : "rules",
      sources: rule?.sources,
      offer: offerIt ? { text: words, mode, details, status: "offered" } : undefined,
    };
    setMessages((list) => [...list, reply]);
    setThinking(false);
    if (getReadAloud()) play(reply.id, reply.text);
  }

  async function sendOffer(msg: Message) {
    const offer = msg.offer;
    const field = offer && myFields.find((f) => f.id === offer.details.fieldId);
    if (!offer || !field) return;
    const { details } = offer;
    setSending(msg.id);
    const completion = details.kind === "completion" ? matchCompletionTask(state, user.id, field.id, details.taskType) : undefined;
    const ok = await run(
      (s) =>
        submitReport(
          s,
          {
            kind: details.kind,
            inputMode: offer.mode,
            fieldId: field.id,
            crop: field.crop,
            transcript: offer.text,
            symptom: details.kind === "problem" ? details.symptom || undefined : undefined,
            severity: details.kind === "problem" ? details.severity : "low",
            requestedResource: details.kind === "resource_request" ? details.requestedResource || undefined : undefined,
            taskType: details.taskType,
            language: lang,
            answer: msg.text,
            answerBy: msg.by,
            completesTaskId: completion?.id,
          },
          user.id,
        ).state,
      { success: tx(lang, "forwarded") },
    );
    setSending(null);
    if (ok) patchOffer(msg.id, { status: "sent" });
  }

  function beginRecording() {
    stopSpeaking();
    unlockAudio();
    setError(null);
    setLiveText("");
    setElapsed(0);
    setVoice("recording");
    const onDone = (result: { text: string } | { error: SpeechErrorKind }) => {
      session.current = null;
      setVoice("idle");
      setLiveText("");
      if ("text" in result) void send(result.text, "voice");
      else setError(result.error);
    };
    session.current =
      engine === "sarvam"
        ? startCloudListening(lang, { onTick: setElapsed, onProcessing: () => setVoice("processing"), onDone })
        : startListening(lang, { onText: setLiveText, onDone });
  }

  function stopRecording() {
    if (engine !== "sarvam") setVoice("processing");
    session.current?.stop();
  }

  function cancelRecording() {
    session.current?.abort();
    session.current = null;
    setVoice("idle");
    setLiveText("");
  }

  function newConversation() {
    stopSpeaking();
    setPlaying(null);
    setMessages([]);
    setError(null);
  }

  function submitTyped(e: FormEvent) {
    e.preventDefault();
    void send(draft, "typed");
  }

  const errorText =
    error === "denied" ? t("voiceDenied") : error === "no-speech" ? tx(lang, "noSpeechHeard") : error === "failed" ? t("voiceFailed") : error === "unsupported" ? t("voiceUnavailable") : null;
  const busy = thinking || voice !== "idle";

  return (
    <div className="flex min-h-[calc(100dvh-12rem)] flex-col">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{tx(lang, "readyTitle")}</h1>
        {messages.length > 0 && (
          <Button variant="ghost" size="md" icon={RotateCcw} onClick={newConversation} disabled={thinking}>
            {tx(lang, "newChat")}
          </Button>
        )}
      </div>

      {myFields.length === 0 && <p className="mt-3 rounded-panel bg-terracotta-tint p-3 text-ink-strong">{tx(lang, "noFieldsAssigned")}</p>}

      <ol className="mt-4 flex-1 space-y-4" aria-live="polite" aria-relevant="additions">
        <li>
          <UrvaraBubble>
            <p className="text-lg leading-relaxed text-ink-strong">{tx(lang, "chatIntro")}</p>
          </UrvaraBubble>
          {messages.length === 0 && (
            <div className="mt-4">
              <p className="text-base font-semibold text-ink-strong">{t("samples")}</p>
              <p className="text-base text-ink-muted">{t("samplesHint")}</p>
              <ul className="mt-2 space-y-2">
                {SAMPLES[lang].map((s) => (
                  <li key={s}>
                    <button
                      type="button"
                      onClick={() => void send(s, "demo_sample")}
                      className="flex min-h-12 w-full items-center gap-2 rounded-control border border-dashed border-line-strong bg-canvas px-3 py-2 text-left text-ink-strong hover:border-forest/60 hover:bg-forest-tint/50"
                    >
                      <Chip tone="gold" className="shrink-0">
                        {pick(lang, "Demo", "डेमो", "ਡੈਮੋ")}
                      </Chip>
                      <span>“{s}”</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </li>

        {messages.map((m) =>
          m.role === "farmer" ? (
            <li key={m.id} className="flex flex-col items-end gap-1">
              <p className="max-w-[85%] rounded-panel rounded-br-sm bg-forest px-3.5 py-2.5 text-lg leading-relaxed text-ivory">{m.text}</p>
              {m.mode && <ModeTag mode={m.mode} lang={lang} />}
            </li>
          ) : (
            <li key={m.id}>
              <UrvaraBubble>
                <p className="text-lg leading-relaxed text-ink-strong">{m.text}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={Volume2}
                    loading={playing?.id === m.id && playing.status === "loading"}
                    onClick={() => play(m.id, m.text)}
                    className="h-10"
                  >
                    {t("listen")}
                  </Button>
                  {m.by === "ai" && (
                    <Chip tone="sage" icon={Sparkles}>
                      {tx(lang, "aiReply")}
                    </Chip>
                  )}
                </div>
                {playing?.id === m.id && (playing.status === "blocked" || playing.status === "failed") && (
                  <p className="mt-1 text-base text-ink-muted">{playing.status === "blocked" ? tx(lang, "tapToListen") : tx(lang, "speechNotSupportedListen")}</p>
                )}
                {m.sources && m.sources.length > 0 && (
                  <div className="mt-3 border-t border-line pt-2">
                    <p className="text-sm font-semibold text-ink-muted">{t("basedOn")}</p>
                    <ul className="mt-1 space-y-1">
                      {m.sources.map((s) => (
                        <li key={s.label} className="flex flex-wrap items-center gap-2 text-sm text-ink">
                          <span className="font-medium">{s.label}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </UrvaraBubble>
              {m.offer && (
                <OfferCard
                  msg={m}
                  offer={m.offer}
                  state={state}
                  user={user}
                  lang={lang}
                  busy={sending === m.id}
                  onChange={(patch) => patchOffer(m.id, patch)}
                  onSend={() => void sendOffer(m)}
                />
              )}
            </li>
          ),
        )}

        {thinking && (
          <li>
            <UrvaraBubble>
              <p className="flex items-center gap-2 text-lg text-ink-muted">
                <LoaderCircle aria-hidden className="size-5 animate-spin" />
                {tx(lang, "thinking")}
              </p>
            </UrvaraBubble>
          </li>
        )}
      </ol>
      {/* Scroll target sits clear of the sticky composer and bottom nav. */}
      <div ref={endRef} className="scroll-mb-48 lg:scroll-mb-28" />

      <div className="sticky bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-20 -mx-4 mt-4 border-t border-line bg-canvas/95 px-4 pb-2 pt-3 backdrop-blur-sm lg:bottom-0 lg:pb-4">
        {errorText && (
          <p role="alert" className="mb-2 flex gap-2 rounded-panel bg-terracotta-tint p-2.5 text-base text-ink-strong">
            <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0 text-terracotta-ink" />
            {errorText}
          </p>
        )}
        {voice !== "idle" ? (
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1 rounded-control bg-sunken px-3 py-2.5" aria-live="polite">
              <p className="font-semibold text-ink-strong">{voice === "processing" ? (engine === "sarvam" ? tx(lang, "sarvamWorking") : t("processing")) : t("listening")}</p>
              <p className="tabular truncate text-base text-ink">
                {engine === "sarvam" ? (voice === "recording" ? `0:${String(elapsed).padStart(2, "0")} / 0:${MAX_CLIP_SECONDS}` : "…") : liveText || "…"}
              </p>
            </div>
            {voice === "recording" && (
              <>
                <button type="button" onClick={cancelRecording} aria-label={t("cancel")} className="grid size-12 shrink-0 place-items-center rounded-full border border-line-strong bg-surface text-ink-strong">
                  <X aria-hidden className="size-5" />
                </button>
                <button type="button" onClick={stopRecording} aria-label={t("stop")} className="animate-record grid size-16 shrink-0 place-items-center rounded-full bg-terracotta-ink text-ivory">
                  <Square aria-hidden className="size-7 fill-current" />
                </button>
              </>
            )}
            {voice === "processing" && <LoaderCircle aria-hidden className="size-8 shrink-0 animate-spin text-forest" />}
          </div>
        ) : (
          <form onSubmit={submitTyped} className="flex items-center gap-2">
            <label htmlFor="chat-input" className="sr-only">
              {tx(lang, "chatPlaceholder")}
            </label>
            <TextInput id="chat-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={tx(lang, "chatPlaceholder")} className="h-12 min-w-0 flex-1 text-lg" disabled={thinking} />
            {draft.trim() ? (
              <button type="submit" disabled={busy} aria-label={tx(lang, "sendMessage")} className="grid size-16 shrink-0 place-items-center rounded-full bg-forest text-ivory hover:bg-forest-hover disabled:opacity-60">
                <SendHorizontal aria-hidden className="size-7" />
              </button>
            ) : (
              <button
                type="button"
                onClick={beginRecording}
                disabled={busy || engine === "none"}
                aria-label={engine === "none" ? t("voiceUnavailable") : t("tapToSpeak")}
                className="grid size-16 shrink-0 place-items-center rounded-full bg-forest text-ivory hover:bg-forest-hover disabled:opacity-50"
              >
                <Mic aria-hidden className="size-8" />
              </button>
            )}
          </form>
        )}
      </div>
    </div>
  );
}

function UrvaraBubble({ children }: { children: ReactNode }) {
  return <div className="max-w-[92%] rounded-panel rounded-bl-sm border border-line bg-surface px-3.5 py-3 shadow-panel">{children}</div>;
}

function OfferCard({
  msg,
  offer,
  state,
  user,
  lang,
  busy,
  onChange,
  onSend,
}: {
  msg: Message;
  offer: Offer;
  state: UrvaraState;
  user: User;
  lang: Language;
  busy: boolean;
  onChange: (patch: Partial<Offer>) => void;
  onSend: () => void;
}) {
  const t = (k: I18nKey) => tr(lang, k);
  const field = state.fields.find((f) => f.id === offer.details.fieldId);
  const Icon = KIND_ICON[offer.details.kind];

  if (offer.status === "sent") {
    return (
      <p className="ml-3 mt-2 flex items-center gap-2 text-base font-semibold text-sage-ink">
        <CheckCircle2 aria-hidden className="size-5" />
        {tx(lang, "forwarded")}
      </p>
    );
  }

  if (offer.status === "editing") {
    return (
      <div className="mt-3 rounded-panel border border-forest/40 bg-surface p-3.5">
        <Review
          state={state}
          user={user}
          lang={lang}
          text={offer.text}
          mode={offer.mode}
          details={offer.details}
          onChange={(details) => onChange({ details })}
          onTextChange={(text) => onChange({ text })}
          onSubmit={onSend}
          busy={busy}
          submitLabel={tx(lang, "sendToOwner")}
        />
        <Button variant="ghost" size="lg" className="mt-2 w-full" onClick={() => onChange({ status: "offered" })}>
          {t("cancel")}
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-3 max-w-[92%] rounded-panel border border-dashed border-forest/50 bg-forest-tint/40 p-3.5" aria-labelledby={`offer-${msg.id}`}>
      <p id={`offer-${msg.id}`} className="font-semibold text-ink-strong">
        {tx(lang, "offerTitle")}
      </p>
      <p className="mt-1 flex items-center gap-2 text-base text-ink">
        <Icon aria-hidden className="size-5 shrink-0 text-forest" />
        <span>
          {t(`kind_${offer.details.kind}` as I18nKey)}
          {field && ` · ${field.name} · ${cropLabel(field.crop, lang)}`}
          {offer.details.kind === "problem" && offer.details.symptom && ` · ${offer.details.symptom}`}
        </span>
      </p>
      <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
        <Button size="lg" icon={SendHorizontal} loading={busy} onClick={onSend} disabled={!field}>
          {tx(lang, "sendToOwner")}
        </Button>
        <Button size="lg" variant="secondary" icon={PencilLine} onClick={() => onChange({ status: "editing" })} disabled={busy}>
          {tx(lang, "changeDetails")}
        </Button>
      </div>
    </div>
  );
}
