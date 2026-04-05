"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const API_BASE = "http://localhost:5000";

function tokenize(text) {
  if (!text) return [];
  return String(text).split(/(\s+)/);
}

/** Word-level LCS diff for prompt visualization */
function computeWordDiff(oldText, newText) {
  const a = tokenize(oldText ?? "");
  const b = tokenize(newText ?? "");
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const raw = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      raw.push({ type: "same", text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      raw.push({ type: "add", text: b[j - 1] });
      j--;
    } else {
      raw.push({ type: "del", text: a[i - 1] });
      i--;
    }
  }
  raw.reverse();
  const merged = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last && last.type === seg.type) last.text += seg.text;
    else merged.push({ type: seg.type, text: seg.text });
  }
  return merged;
}

function parseGenerateReply(data) {
  if (data == null) return "";
  const v = data.aiReply;
  return typeof v === "string" ? v : v != null ? String(v) : "";
}

function parseImproveAiPayload(data) {
  const oldPrompt =
    data?.old_prompt ??
    data?.oldPrompt ??
    data?.previous_prompt ??
    data?.previous ??
    data?.before ??
    "";
  const newPrompt =
    data?.new_prompt ??
    data?.newPrompt ??
    data?.updated_prompt ??
    data?.current ??
    data?.after ??
    "";
  return { oldPrompt: String(oldPrompt), newPrompt: String(newPrompt) };
}

function messagesToChatHistory(msgs) {
  return msgs.map((m) => ({
    direction: m.role === "user" ? "in" : "out",
    text: m.content,
  }));
}

export default function Home() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState(null);
  const [diffLog, setDiffLog] = useState([]);
  const [feedbackMessageId, setFeedbackMessageId] = useState(null);
  const [feedbackText, setFeedbackText] = useState("");
  const [submittingFeedbackForId, setSubmittingFeedbackForId] = useState(null);
  const [feedbackConfirmedIds, setFeedbackConfirmedIds] = useState({});
  const [feedbackGuardrailForId, setFeedbackGuardrailForId] = useState(null);
  const listEndRef = useRef(null);

  const scrollToBottom = useCallback(() => {
    listEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping, scrollToBottom]);

  const sendMessage = async (e) => {
    e?.preventDefault?.();
    const text = input.trim();
    if (!text || isTyping) return;

    setError(null);
    const userMsg = { id: crypto.randomUUID(), role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsTyping(true);

    try {
      const res = await fetch(`${API_BASE}/generate-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSequence: [{ text }],
          chatHistory: messagesToChatHistory(messages),
        }),
      });
      if (!res.ok) {
        throw new Error(`generate-reply failed (${res.status})`);
      }
      const data = await res.json();
      console.log("/generate-reply full response:", data);
      const reply = parseGenerateReply(data);
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: reply || "(Empty reply)",
        },
      ]);
    } catch (err) {
      setError(err?.message ?? "Could not reach the server");
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content:
            "Sorry — I could not reach the consultant service. Is the API running on port 5000?",
        },
      ]);
    } finally {
      setIsTyping(false);
    }
  };

  const openFeedbackFor = (messageId) => {
    setError(null);
    setFeedbackGuardrailForId(null);
    setFeedbackText("");
    setFeedbackMessageId((cur) => (cur === messageId ? null : messageId));
  };

  const submitManualFeedback = async (messageId) => {
    const instructions = feedbackText.trim();
    if (!instructions || submittingFeedbackForId) return;

    setError(null);
    setFeedbackGuardrailForId(null);
    setSubmittingFeedbackForId(messageId);
    try {
      const res = await fetch(`${API_BASE}/improve-ai-manually`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions }),
      });
      if (!res.ok) {
        if (res.status === 400) {
          let body = null;
          try {
            body = await res.json();
          } catch {
            /* non-JSON body */
          }
          if (body?.code === "guardrail_rejected") {
            setFeedbackGuardrailForId(messageId);
            return;
          }
        }
        throw new Error(`improve-ai-manually failed (${res.status})`);
      }
      const data = await res.json();
      const { oldPrompt, newPrompt } = parseImproveAiPayload(data);
      const ts = new Date().toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
      });
      setDiffLog((prev) => [
        {
          id: crypto.randomUUID(),
          timestamp: ts,
          instruction: instructions,
          oldPrompt,
          newPrompt,
          segments: computeWordDiff(oldPrompt, newPrompt),
        },
        ...prev,
      ]);
      setFeedbackConfirmedIds((prev) => ({ ...prev, [messageId]: true }));
      setFeedbackMessageId(null);
      setFeedbackText("");
    } catch (err) {
      setError(err?.message ?? "Feedback request failed");
    } finally {
      setSubmittingFeedbackForId(null);
    }
  };

  return (
    <div className="min-h-full flex flex-col bg-zinc-950 text-zinc-100">
      <header className="shrink-0 border-b border-zinc-800/80 bg-zinc-900/50 px-4 py-3 backdrop-blur-sm">
        <h1 className="text-lg font-semibold tracking-tight text-white">
          Visa Consultant
        </h1>
        <p className="text-xs text-zinc-500">
          Live advisory chat · prompt learning log
        </p>
      </header>

      <div className="flex flex-1 flex-col gap-4 p-4 lg:flex-row lg:gap-5 lg:p-5 min-h-0">
        {/* Left: Live Chat */}
        <section className="flex min-h-[420px] flex-1 flex-col overflow-hidden rounded-2xl border border-zinc-800/90 bg-zinc-900/40 shadow-xl shadow-black/20 lg:min-h-0">
          <div className="flex items-center justify-between border-b border-zinc-800/80 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-white">Live Chat</h2>
              <p className="text-xs text-zinc-500">Client &amp; AI consultant</p>
            </div>
            <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-400">
              Session
            </span>
          </div>

          <div className="flex flex-1 flex-col min-h-0 bg-zinc-950/50">
            <div className="flex-1 space-y-3 overflow-y-auto px-3 py-4">
              {messages.length === 0 && (
                <p className="px-2 text-center text-sm text-zinc-500 pt-8">
                  Start a conversation about visas, documents, or timelines.
                </p>
              )}
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex flex-col gap-1.5 ${
                    m.role === "user" ? "items-end" : "items-start"
                  }`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[15px] leading-relaxed shadow-sm ${
                      m.role === "user"
                        ? "rounded-br-md bg-blue-600 text-white"
                        : "rounded-bl-md border border-zinc-700/60 bg-white text-zinc-900"
                    }`}
                  >
                    <p className="whitespace-pre-wrap break-words">
                      {m.content}
                    </p>
                  </div>
                  {m.role === "assistant" && feedbackConfirmedIds[m.id] && (
                    <p className="ml-1 text-xs font-medium text-emerald-400">
                      AI updated ✓
                    </p>
                  )}
                  {m.role === "assistant" && !feedbackConfirmedIds[m.id] && (
                    <button
                      type="button"
                      disabled={submittingFeedbackForId !== null}
                      onClick={() => openFeedbackFor(m.id)}
                      className="ml-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-50"
                    >
                      Give Feedback
                    </button>
                  )}
                  {m.role === "assistant" &&
                    feedbackMessageId === m.id &&
                    !feedbackConfirmedIds[m.id] && (
                      <div className="ml-1 mt-1 w-full max-w-[85%] space-y-2 rounded-xl border border-zinc-700/70 bg-zinc-900/90 p-3">
                        <input
                          type="text"
                          value={feedbackText}
                          onChange={(e) => {
                            setFeedbackText(e.target.value);
                            setFeedbackGuardrailForId(null);
                          }}
                          placeholder="e.g. too long, be more casual, ask fewer questions"
                          disabled={submittingFeedbackForId !== null}
                          className="w-full rounded-lg border border-zinc-600/80 bg-zinc-950/80 px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/20"
                          autoComplete="off"
                        />
                        <button
                          type="button"
                          disabled={
                            submittingFeedbackForId !== null ||
                            !feedbackText.trim()
                          }
                          onClick={() => submitManualFeedback(m.id)}
                          className="w-full rounded-lg bg-amber-600/90 py-2 text-xs font-semibold text-white transition hover:bg-amber-500 disabled:opacity-40"
                        >
                          {submittingFeedbackForId === m.id
                            ? "Submitting…"
                            : "Submit"}
                        </button>
                        {feedbackGuardrailForId === m.id && (
                          <p className="rounded-lg border border-amber-500/40 bg-amber-950/50 px-3 py-2 text-xs leading-relaxed text-amber-100">
                            This feedback was flagged as potentially harmful and
                            wasn&apos;t applied. Please try a different
                            instruction.
                          </p>
                        )}
                      </div>
                    )}
                </div>
              ))}
              {isTyping && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-1 rounded-2xl rounded-bl-md border border-zinc-700/60 bg-zinc-800/80 px-4 py-3">
                    <span className="visa-typing-dot h-2 w-2 rounded-full bg-zinc-400" />
                    <span className="visa-typing-dot visa-typing-dot-d1 h-2 w-2 rounded-full bg-zinc-400" />
                    <span className="visa-typing-dot visa-typing-dot-d2 h-2 w-2 rounded-full bg-zinc-400" />
                  </div>
                </div>
              )}
              <div ref={listEndRef} />
            </div>

            {error && (
              <div className="mx-3 mb-2 rounded-lg border border-red-500/30 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                {error}
              </div>
            )}

            <form
              onSubmit={sendMessage}
              className="flex gap-2 border-t border-zinc-800/80 bg-zinc-900/60 p-3"
            >
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type a message…"
                className="min-w-0 flex-1 rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-4 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none ring-0 focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20"
                disabled={isTyping}
                autoComplete="off"
              />
              <button
                type="submit"
                disabled={isTyping || !input.trim()}
                className="shrink-0 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-900/30 transition hover:bg-blue-500 disabled:opacity-40"
              >
                Send
              </button>
            </form>
          </div>
        </section>

        {/* Right: Prompt diff log */}
        <section className="flex min-h-[320px] flex-1 flex-col overflow-hidden rounded-2xl border border-zinc-800/90 bg-zinc-900/40 shadow-xl shadow-black/20 lg:min-h-0">
          <div className="border-b border-zinc-800/80 px-4 py-3">
            <h2 className="text-sm font-semibold text-white">
              AI Self-Learning Log
            </h2>
            <p className="text-xs text-zinc-500">
              Prompt updates after each feedback submission
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {diffLog.length === 0 ? (
              <div className="flex h-full min-h-[200px] flex-col items-center justify-center rounded-xl border border-dashed border-zinc-700/60 bg-zinc-950/30 px-6 text-center">
                <p className="text-sm text-zinc-500">
                  Give feedback on a reply to see prompt improvements here
                </p>
              </div>
            ) : (
              <ul className="space-y-4">
                {diffLog.map((entry) => (
                  <li
                    key={entry.id}
                    className="rounded-xl border border-zinc-800/80 bg-zinc-950/40 p-4"
                  >
                    <time className="mb-2 block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                      {entry.timestamp}
                    </time>
                    {entry.instruction != null && entry.instruction !== "" && (
                      <p className="mb-3 rounded-lg border border-zinc-700/50 bg-zinc-900/50 px-3 py-2 text-[13px] text-zinc-300">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                          Instruction
                        </span>
                        <span className="mt-1 block text-zinc-200">
                          {entry.instruction}
                        </span>
                      </p>
                    )}
                    <div className="rounded-lg bg-zinc-900/80 p-3 font-mono text-[13px] leading-relaxed text-zinc-200">
                      {entry.oldPrompt === entry.newPrompt ? (
                        <span className="text-zinc-500">
                          Feedback noted — prompt already reflects this or change
                          was too subtle to diff. Send a new message to see the
                          effect.
                        </span>
                      ) : (
                        entry.segments.map((seg, idx) => {
                          if (seg.type === "same") {
                            return (
                              <span key={idx} className="text-zinc-300">
                                {seg.text}
                              </span>
                            );
                          }
                          if (seg.type === "del") {
                            return (
                              <span
                                key={idx}
                                className="bg-red-950/80 text-red-300 line-through decoration-red-400/80"
                              >
                                {seg.text}
                              </span>
                            );
                          }
                          return (
                            <span
                              key={idx}
                              className="bg-emerald-950/70 text-emerald-300"
                            >
                              {seg.text}
                            </span>
                          );
                        })
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      <style
        dangerouslySetInnerHTML={{
          __html: `
            @keyframes visa-typing-bounce {
              0%, 80%, 100% { transform: translateY(0); opacity: 0.45; }
              40% { transform: translateY(-6px); opacity: 1; }
            }
            .visa-typing-dot { animation: visa-typing-bounce 1.2s ease-in-out infinite; }
            .visa-typing-dot-d1 { animation-delay: 0.2s; }
            .visa-typing-dot-d2 { animation-delay: 0.4s; }
          `,
        }}
      />
    </div>
  );
}
