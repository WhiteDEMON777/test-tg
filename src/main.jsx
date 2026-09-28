import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const DEFAULT_API_URL = "https://api.green-api.com";
const STORAGE_KEY = "green-api-telegram-chat";

const createMessage = ({ id, chatId, text, direction, status = "sent", timestamp = Date.now() }) => ({
  id: id || `${direction}-${timestamp}-${Math.random().toString(16).slice(2)}`,
  chatId,
  text,
  direction,
  status,
  timestamp,
});

const formatTime = (timestamp) =>
  new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);

const normalizeChatId = (value) => {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  if (trimmed.includes("@") || trimmed.startsWith("-")) {
    return trimmed;
  }

  const digits = trimmed.replace(/[^\d]/g, "");
  return digits ? `${digits}@c.us` : trimmed;
};

const getStoredState = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

const buildApiUrl = ({ apiUrl, idInstance, apiTokenInstance }, method, tail = "") => {
  const base = apiUrl.replace(/\/$/, "");
  return `${base}/waInstance${idInstance}/${method}/${apiTokenInstance}${tail}`;
};

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = data?.message || data?.reason || data?.error || response.statusText;
    throw new Error(message);
  }

  return data;
}

function extractTextMessage(notification) {
  const body = notification?.body;
  const messageData = body?.messageData;
  const text =
    messageData?.textMessageData?.textMessage ||
    messageData?.extendedTextMessageData?.text ||
    messageData?.quotedMessage?.textMessage ||
    "";

  if (!body || body.typeWebhook !== "incomingMessageReceived" || !text || messageData?.typeMessage !== "textMessage") {
    return null;
  }

  const senderData = body.senderData || {};
  const chatId = senderData.chatId || senderData.sender || "";

  return createMessage({
    id: body.idMessage,
    chatId,
    text,
    direction: "incoming",
    timestamp: body.timestamp ? body.timestamp * 1000 : Date.now(),
    status: "received",
  });
}

function App() {
  const stored = useMemo(getStoredState, []);
  const [credentials, setCredentials] = useState({
    apiUrl: stored.credentials?.apiUrl || DEFAULT_API_URL,
    idInstance: stored.credentials?.idInstance || "",
    apiTokenInstance: stored.credentials?.apiTokenInstance || "",
  });
  const [draftChat, setDraftChat] = useState(stored.activeChatId || "");
  const [activeChatId, setActiveChatId] = useState(stored.activeChatId || "");
  const [messages, setMessages] = useState(stored.messages || []);
  const [messageText, setMessageText] = useState("");
  const [isPolling, setIsPolling] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [status, setStatus] = useState("Введите учетные данные и создайте чат.");
  const [error, setError] = useState("");
  const messagesRef = useRef(null);
  const seenMessageIds = useRef(new Set((stored.messages || []).map((message) => message.id)));

  const isReady = credentials.idInstance.trim() && credentials.apiTokenInstance.trim();
  const canSend = isReady && activeChatId && messageText.trim() && !isSending;
  const activeMessages = messages.filter((message) => message.chatId === activeChatId);

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        credentials,
        activeChatId,
        messages,
      }),
    );
  }, [activeChatId, credentials, messages]);

  useEffect(() => {
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [activeMessages.length]);

  useEffect(() => {
    if (!isReady) {
      setIsPolling(false);
    }
  }, [isReady]);

  useEffect(() => {
    if (!isPolling || !isReady) {
      return undefined;
    }

    let isCancelled = false;

    const poll = async () => {
      try {
        setStatus("Ожидаем входящие сообщения...");
        const url = buildApiUrl(credentials, "receiveNotification", "?receiveTimeout=5");
        const notification = await requestJson(url);

        if (isCancelled) {
          return;
        }

        if (notification?.receiptId) {
          const receivedMessage = extractTextMessage(notification);

          if (receivedMessage && !seenMessageIds.current.has(receivedMessage.id)) {
            seenMessageIds.current.add(receivedMessage.id);
            setMessages((current) => [...current, receivedMessage]);
            setStatus("Получено новое текстовое сообщение.");
          }

          const deleteUrl = buildApiUrl(credentials, "deleteNotification", `/${notification.receiptId}`);
          await requestJson(deleteUrl, { method: "DELETE" });
        }
      } catch (pollError) {
        if (!isCancelled) {
          setError(pollError.message);
          setStatus("Получение сообщений остановлено из-за ошибки.");
          setIsPolling(false);
        }
      }

      if (!isCancelled) {
        window.setTimeout(poll, 700);
      }
    };

    poll();

    return () => {
      isCancelled = true;
    };
  }, [credentials, isPolling, isReady]);

  const updateCredentials = (field, value) => {
    setCredentials((current) => ({
      ...current,
      [field]: value,
    }));
    setError("");
  };

  const createChat = (event) => {
    event.preventDefault();
    const chatId = normalizeChatId(draftChat);

    if (!chatId) {
      setError("Введите номер телефона или chatId получателя.");
      return;
    }

    setActiveChatId(chatId);
    setDraftChat(chatId);
    setError("");
    setStatus(`Чат ${chatId} создан.`);
  };

  const sendMessage = async (event) => {
    event.preventDefault();

    if (!canSend) {
      return;
    }

    const text = messageText.trim();
    const optimisticMessage = createMessage({
      chatId: activeChatId,
      text,
      direction: "outgoing",
      status: "sending",
    });

    setIsSending(true);
    setError("");
    setMessageText("");
    setMessages((current) => [...current, optimisticMessage]);

    try {
      const url = buildApiUrl(credentials, "sendMessage");
      const response = await requestJson(url, {
        method: "POST",
        body: JSON.stringify({
          chatId: activeChatId,
          message: text,
        }),
      });

      setMessages((current) =>
        current.map((message) =>
          message.id === optimisticMessage.id
            ? {
                ...message,
                id: response?.idMessage || message.id,
                status: "sent",
              }
            : message,
        ),
      );
      setStatus("Сообщение отправлено.");
    } catch (sendError) {
      setMessages((current) =>
        current.map((message) =>
          message.id === optimisticMessage.id
            ? {
                ...message,
                status: "failed",
              }
            : message,
        ),
      );
      setError(sendError.message);
      setStatus("Не удалось отправить сообщение.");
    } finally {
      setIsSending(false);
    }
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">T</span>
          <div>
            <h1>Telegram Chat</h1>
            <p>GREEN-API</p>
          </div>
        </div>

        <section className="panel">
          <h2>Доступ</h2>
          <label>
            API URL
            <input
              value={credentials.apiUrl}
              onChange={(event) => updateCredentials("apiUrl", event.target.value)}
              placeholder={DEFAULT_API_URL}
            />
          </label>
          <label>
            idInstance
            <input
              value={credentials.idInstance}
              onChange={(event) => updateCredentials("idInstance", event.target.value)}
              inputMode="numeric"
              placeholder="1103123456"
            />
          </label>
          <label>
            apiTokenInstance
            <input
              value={credentials.apiTokenInstance}
              onChange={(event) => updateCredentials("apiTokenInstance", event.target.value)}
              type="password"
              placeholder="ваш токен"
            />
          </label>
        </section>

        <form className="panel" onSubmit={createChat}>
          <h2>Новый чат</h2>
          <label>
            Телефон или chatId
            <input
              value={draftChat}
              onChange={(event) => setDraftChat(event.target.value)}
              placeholder="79991234567"
            />
          </label>
          <button type="submit" className="primary">
            Создать чат
          </button>
        </form>

        <button
          className={isPolling ? "toggle active" : "toggle"}
          disabled={!isReady}
          onClick={() => {
            setError("");
            setIsPolling((current) => !current);
          }}
        >
          {isPolling ? "Получение включено" : "Включить получение"}
        </button>
      </aside>

      <section className="chat">
        <header className="chat-header">
          <div className="avatar">{activeChatId ? activeChatId.slice(0, 1).toUpperCase() : "T"}</div>
          <div>
            <h2>{activeChatId || "Чат не выбран"}</h2>
            <p>{status}</p>
          </div>
        </header>

        <div className="messages" ref={messagesRef}>
          {!activeChatId && (
            <div className="empty-state">
              <strong>Начните с учетных данных GREEN-API.</strong>
              <span>Затем введите телефон получателя и создайте чат.</span>
            </div>
          )}

          {activeChatId && activeMessages.length === 0 && (
            <div className="empty-state">
              <strong>Чат готов.</strong>
              <span>Отправьте первое текстовое сообщение в Telegram.</span>
            </div>
          )}

          {activeMessages.map((message) => (
            <article key={message.id} className={`message ${message.direction}`}>
              <p>{message.text}</p>
              <footer>
                <span>{formatTime(message.timestamp)}</span>
                {message.direction === "outgoing" && <span>{message.status === "failed" ? "ошибка" : "✓"}</span>}
              </footer>
            </article>
          ))}
        </div>

        {error && <div className="error">{error}</div>}

        <form className="composer" onSubmit={sendMessage}>
          <textarea
            value={messageText}
            onChange={(event) => setMessageText(event.target.value)}
            placeholder="Сообщение"
            rows="1"
            maxLength="4000"
            disabled={!activeChatId}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendMessage(event);
              }
            }}
          />
          <button type="submit" disabled={!canSend} aria-label="Отправить">
            ➤
          </button>
        </form>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
