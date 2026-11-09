const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const thread = $("#thread");
const form = $("#composer");
const input = $("#input");
const sendButton = $("#send");
const suggestions = $("#suggestions");
const live = $("#live");

let history = [];
let busy = false;
let messageCount = 0;
let scrollQueued = false;

/* ---------------------------------------------------------------- date */

const now = new Date();
const today = $("#today");
today.textContent = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric"
}).format(now);
today.setAttribute("datetime", now.toISOString().slice(0, 10));

/* ------------------------------------------------------------- edition */

async function loadEdition() {
  try {
    const response = await fetch("/api/articles", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`edition responded ${response.status}`);

    const data = await response.json();
    const articles = Array.isArray(data.articles) ? data.articles : [];
    const edition = data.edition || {};

    renderStories(articles);
    $("#edition-status").textContent = `${articles.length} stories indexed`;
    $("#rail-count").textContent = articles.length
      ? `${articles.length} stories in this edition`
      : "No stories yet — the desk is compiling";

    $("#note-stories").textContent = articles.length ? String(articles.length) : "—";
    $("#note-publishers").textContent = articles.length
      ? String(new Set(articles.map((article) => article.source)).size)
      : "—";
    $("#note-passages").textContent = edition.passages ? String(edition.passages) : "—";

    if (edition.updatedAt) {
      const compiled = new Date(edition.updatedAt);
      $("#updated").textContent = Number.isNaN(compiled.getTime())
        ? "Awaiting the next edition."
        : `${articles.length} stories in the full edition. Last compiled ${formatClock(compiled)}.`;
    } else {
      $("#updated").textContent = "Awaiting the first edition.";
    }
  } catch {
    $("#edition-status").textContent = "Edition unavailable";
    $("#rail-count").textContent = "The edition could not be reached";
    $("#updated").textContent = "The desk is offline.";
  }
}

function renderStories(articles) {
  const list = $("#stories");
  list.textContent = "";

  articles.slice(0, 8).forEach((article, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "story";

    const number = document.createElement("span");
    number.className = "story__n";
    number.textContent = String(index + 1).padStart(2, "0");

    const inner = document.createElement("span");
    const title = document.createElement("span");
    title.className = "story__title";
    title.textContent = article.title || "Untitled";

    const meta = document.createElement("span");
    meta.className = "story__meta";
    meta.textContent = `${article.source || "Dispatch"} · ${formatWhen(article.published)}`;

    inner.append(title, meta);
    button.append(number, inner);
    item.append(button);
    list.append(item);

    button.addEventListener("click", () => {
      if (busy) return;
      input.value = `What does the report on “${article.title}” say?`;
      autosize();
      input.focus();
      document.getElementById("desk").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function formatWhen(value) {
  if (!value) return "Undated";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Undated";
  return `${new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC"
  })
    .format(date)
    .replace(",", "")} UTC`;
}

function formatClock(date) {
  return `${new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC"
  }).format(date)} UTC`;
}

/* --------------------------------------------------------------- turns */

function appendTurn(role, text, options = {}) {
  const article = document.createElement("article");
  article.className = `turn turn--${role}`;
  article.dataset.message = String(++messageCount);

  const meta = document.createElement("div");
  meta.className = "turn__meta";

  const who = document.createElement("span");
  who.className = "turn__who";
  who.textContent = role === "you" ? "You" : "The Desk";

  const time = document.createElement("span");
  time.className = "turn__time";
  time.textContent = "Now";

  meta.append(who, time);

  const body = document.createElement("div");
  body.className = "turn__body";

  const paragraph = document.createElement("p");
  if (text) paragraph.textContent = text;
  body.append(paragraph);

  article.append(meta, body);
  thread.append(article);

  if (options.streaming) article.classList.add("is-streaming");

  return { article, body, paragraph };
}

function showError(turn, message) {
  const note = document.createElement("p");
  note.className = "turn__error";
  note.textContent = message;
  turn.body.append(note);
}

/* ---------------------------------------------------------------- chat */

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  send(text);
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener("input", autosize);

suggestions.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-question]");
  if (!button || busy) return;
  send(button.dataset.question);
});

$("#clear").addEventListener("click", () => {
  if (busy) return;

  $$(".turn", thread).forEach((turn) => {
    if (turn.id !== "intro") turn.remove();
  });

  suggestions.style.display = "";
  history = [];
  input.value = "";
  autosize();
  input.focus();
});

async function send(text) {
  busy = true;
  sendButton.disabled = true;
  suggestions.style.display = "none";
  input.value = "";
  autosize();

  const priorHistory = history.slice(-4);
  history.push({ role: "user", content: text });

  appendTurn("you", text);
  const turn = appendTurn("desk", "", { streaming: true });
  turn.paragraph.style.whiteSpace = "pre-wrap";

  const messageId = `m${messageCount}`;
  let answer = "";
  let sources = [];
  let finished = false;

  scrollToTurn(turn.article);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ message: text, history: priorHistory })
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "The desk could not take that question.");
    }

    if (!response.body) {
      throw new Error("The desk did not return a readable answer.");
    }

    await readEvents(response.body, (event, data) => {
      if (event === "citations" && Array.isArray(data)) {
        sources = data;
      }

      if (event === "token" && data && typeof data.t === "string") {
        answer += data.t;
        turn.paragraph.textContent = answer.replace(/\*\*/g, "");
        keepInView();
      }

      if (event === "error") {
        throw new Error(data && data.message ? data.message : "The desk stopped mid-answer.");
      }

      if (event === "done") {
        finish();
      }
    });

    finish();
  } catch (error) {
    finish(error);
  } finally {
    busy = false;
    sendButton.disabled = false;
    input.focus({ preventScroll: true });
  }

  function finish(error) {
    if (finished) return;
    finished = true;

    turn.article.classList.remove("is-streaming");
    turn.paragraph.style.whiteSpace = "";

    if (answer.trim()) {
      const clean = answer
        .trim()
        .replace(/\[(\d{1,2})\]/g, (match, value) => {
          const number = Number(value);
          return number >= 1 && number <= sources.length ? match : "";
        });

      const cited = new Set(
        Array.from(clean.matchAll(/\[(\d{1,2})\]/g)).map((match) => Number(match[1]))
      );
      const used = sources.filter((source) => cited.has(source.n));

      turn.paragraph.innerHTML = formatAnswer(clean, messageId);
      renderSources(
        turn.body,
        used.length ? used : sources,
        messageId,
        used.length ? "Sources in this answer" : "Sources retrieved"
      );
      history.push({ role: "assistant", content: clean });
      live.textContent = "Answer ready.";
    } else {
      turn.paragraph.remove();
    }

    if (error) {
      showError(turn, error.message || "The desk could not finish that answer.");
      live.textContent = "The desk could not answer.";
    }

    keepInView(true);
  }
}

async function readEvents(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let event = "message";
      const data = [];

      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).trimStart());
        }
      }

      if (data.length) {
        let payload = null;
        try {
          payload = JSON.parse(data.join("\n"));
        } catch {
          payload = null;
        }
        if (payload !== null) onEvent(event, payload);
      }

      boundary = buffer.indexOf("\n\n");
    }
  }
}

/* ------------------------------------------------------------- display */

function formatAnswer(text, messageId) {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => {
      let html = escapeHtml(paragraph).replace(/\n/g, "<br>");
      html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      html = html.replace(
        /\[(\d{1,2})\]/g,
        `<sup class="cite"><a href="#${messageId}-src-$1">$1</a></sup>`
      );
      return `<p>${html}</p>`;
    })
    .join("");
}

function renderSources(body, sources, messageId, labelText) {
  if (!sources.length) return;

  const wrap = document.createElement("div");
  wrap.className = "sources";

  const label = document.createElement("p");
  label.className = "sources__label";
  label.textContent = labelText;

  const list = document.createElement("ol");

  sources.forEach((source) => {
    const item = document.createElement("li");
    item.className = "source";
    item.id = `${messageId}-src-${source.n}`;

    const number = document.createElement("span");
    number.className = "source__n";
    number.textContent = String(source.n).padStart(2, "0");

    const inner = document.createElement("div");
    const link = document.createElement("a");
    link.className = "source__title";
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = source.title;

    const meta = document.createElement("span");
    meta.className = "source__meta";
    meta.textContent = `${source.source} · ${formatWhen(source.published)}`;

    inner.append(link, meta);
    item.append(number, inner);
    list.append(item);
  });

  wrap.append(label, list);
  body.append(wrap);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/* --------------------------------------------------------------- layout */

function autosize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
}

function isNearBottom() {
  return window.innerHeight + window.scrollY > document.documentElement.scrollHeight - 260;
}

function keepInView(force = false) {
  if (!force && !isNearBottom()) return;
  if (scrollQueued) return;

  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
  });
}

function scrollToTurn(element) {
  const top = element.getBoundingClientRect().top + window.scrollY - 28;
  window.scrollTo({ top, behavior: "smooth" });
}

/* ---------------------------------------------------------------- boot */

autosize();
loadEdition();

const shared = new URLSearchParams(window.location.search).get("q");
if (shared) {
  input.value = shared.slice(0, 800);
  autosize();
  requestAnimationFrame(() => form.requestSubmit());
}
