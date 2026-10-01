// ui-kit/src/messages.ts
var FALLBACK_MESSAGES = {
  unknown: { title: "\u51FA\u73B0\u95EE\u9898", body: "\u9519\u8BEF\u7801 {code} \u6682\u65E0\u8BF4\u660E\u3002\u91CD\u8BD5\u53EF\u518D\u8BD5\u4E00\u6B21\u3002" },
  ui_unreachable: {
    title: "\u5BBF\u4E3B\u4E0D\u53EF\u8FBE",
    body: "\u4E0E\u5BBF\u4E3B\u7684\u8FDE\u63A5\u5DF2\u65AD\u5F00\u3002\u68C0\u67E5\u5BBF\u4E3B\u662F\u5426\u5728\u8FD0\u884C\uFF0C\u7136\u540E\u91CD\u8BD5\u3002",
    action: "\u91CD\u8BD5"
  }
};
var LOCALE_KEY = "locale";
var UNKNOWN_CODE = "unknown";
function parseMessages(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const table = {};
  for (const [code, value] of Object.entries(parsed)) {
    if (code === LOCALE_KEY) continue;
    if (typeof value !== "object" || value === null) continue;
    const raw = value;
    if (typeof raw.title !== "string" || typeof raw.body !== "string") continue;
    const entry = { title: raw.title, body: raw.body };
    if (typeof raw.action === "string" && raw.action.length > 0) entry.action = raw.action;
    table[code] = entry;
  }
  return Object.keys(table).length > 0 ? table : null;
}
function createMessages(uiText) {
  const lookupMessage = (table, code) => {
    const source = typeof table === "object" && table !== null ? table : FALLBACK_MESSAGES;
    const entry = source[code];
    if (entry !== void 0) return entry;
    if (typeof uiText[code] === "string") return { title: "", body: uiText[code] };
    const unknown = source[UNKNOWN_CODE] ?? FALLBACK_MESSAGES[UNKNOWN_CODE];
    return { ...unknown, body: unknown.body.replace("{code}", code) };
  };
  const messageText = (table, code) => lookupMessage(table, code).body;
  const formatText = (table, code, vars) => {
    const template = messageText(table, code);
    const values = typeof vars === "object" && vars !== null ? vars : null;
    return template.replace(
      /\{(\w+)\}/g,
      (match, key) => values !== null && Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
    );
  };
  const loadMessages = async (fetchImpl, url) => {
    try {
      const response = await fetchImpl(url);
      if (!response.ok) return FALLBACK_MESSAGES;
      const parsed = parseMessages(await response.text());
      return parsed ?? FALLBACK_MESSAGES;
    } catch {
      return FALLBACK_MESSAGES;
    }
  };
  return { FALLBACK_MESSAGES, parseMessages, lookupMessage, messageText, formatText, loadMessages };
}
export {
  FALLBACK_MESSAGES,
  createMessages,
  parseMessages
};
