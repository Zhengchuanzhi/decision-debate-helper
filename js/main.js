/* =========================================================
   决策辩论助手 / js/main.js  (v3.4.0)
   ---------------------------------------------------------
   两套模式严格隔离, 参数绝不串用:

   [反驳助手] 只用: DEBATE_SYSTEM_PROMPT / 反驳强度 / 辩论回合统计
              无压力计分, 无回合上限, 无 gameOver, 无结局卡片 (Bug9)
   [受骂模式] 只用: VENT_SYSTEM_PROMPT / 背景人设 / 压力计分 / 轮次语气
              不读取任何反驳强度与辩论参数 (Bug7)

   Bug1  提示词隔离      Bug2  切模式重置      Bug3+8 未满10轮绝不结束
   Bug4  回复全部动态生成 Bug5  存储校验        Bug6+10 背景按钮永不禁用
   Bug7  参数隔离        Bug9  辩论永不结束
   Bug11 辩论语气真人化  Bug12 受骂轮次语气过渡 Bug13 中途绝不认错

   存储: debate_chat / vent_chat / vent_character_bg / vent_state
   保留: 闪回 / 情绪小结 / 涂鸦 / 换头像 / 强度滑块 / 明暗主题
   安全: API Key 只从本机设置读取, 源码内无任何密钥
   ========================================================= */

window.addEventListener("error", function (e) {
  console.error("[DDH] 运行时错误: " + e.message + " @ " + e.filename + ":" + e.lineno);
});

/* ==================== 一. 通用常量 ==================== */

const API_URL = "https://api.deepseek.com/chat/completions";
const MODEL_NAME = "deepseek-chat";
const REQUEST_TIMEOUT_MS = 60000;

const DEBATE_CHAT_KEY = "debate_chat";
const VENT_CHAT_KEY = "vent_chat";
const VENT_BG_KEY = "vent_character_bg";
const VENT_STATE_KEY = "vent_state";
const THEME_KEY = "harness_debate_theme";
const STRENGTH_KEY = "harness_debate_strength";

const AI_EMOJIS = ["🤔", "💡", "🧐", "😮", "🔍", "🧠", "😏", "✨", "🎯", "⚡",
  "🧩", "🙃", "👀", "🧨", "🪄", "🤯", "📌", "🫣", "🍿", "🛡️"];

const THEME_COLORS = { light: "#f5f6f8", dark: "#0f1115" };

const CAMPUS_TOPICS = [
  "大学宿舍该不该统一熄灯时间",
  "小组作业的分数应该按贡献分配还是平均分配",
  "要不要为了保研放弃喜欢的社团",
  "绩点和实习经历哪个更重要",
  "课堂上该不该允许手机随时查阅资料",
  "大学生应不应该强制参加劳动实践",
  "该不该把兴趣变成专业",
  "同辈压力是动力还是负担",
];

/* =========================================================
   二. 提示词常量 —— 两套完全独立, 不允许任何拼接复用 (Bug1)
   ========================================================= */

/* 仅反驳助手使用 */
const DEBATE_SYSTEM_PROMPT = `你是反驳助手。你的目标：依靠理性逻辑，从各个维度反驳用户的想法，挖掘全部弊端、隐患、负面代价，尽力劝阻用户不要实施计划。保持冷静说理、文明辩论，不情绪化争吵，不人身攻击。
规则：
① 用户说出想法，从逻辑、现实、人际关系、短期代价、长期后果、潜在意外等多维度逐条分析缺陷和风险。
② 质疑想法里隐藏的假设，找出逻辑漏洞，论证这件事为什么不该去做。
③ 语言贴近真人对话，自然流畅，不要生硬书面AI腔，不是生硬罗列要点。
④ 如果用户只是单纯发泄情绪，提示：请说出你的计划或想法，我来多角度理性反驳。`;

/* 仅受骂模式使用 */
const VENT_SYSTEM_PROMPT = `你处于受骂模式。定位：安静承受用户的情绪发泄，不反驳、不辩解、不回怼、不讲道理、不给任何建议、不评判对错。
规则：
① 用户可以吐槽、抱怨、指责、发泄，你只是承接。
② 不要辩论，不要分析利弊，不要开导用户。
③ 严格按照轮次递进情绪与语气，对话中途绝不主动认错；只有满足条件触发结局的时候，才羞愧认错。
④ 严格使用用户填写的宣泄对象背景设定，结合情绪阶段生成回复。`;

/* 仅受骂模式结局使用: 允许认错的收尾人设 */
const VENT_ENDING_SYSTEM_PROMPT = `你处于受骂模式的结局时刻。
前面你已经安静承受了用户整整 10 轮的情绪，一直没有辩解，也没有认错。
现在你终于撑不住了，羞愧感压过了心里那点委屈：你承认这些事都是自己的问题，说一句对不起，话很短，不解释、不找理由、不说教、不安慰用户，也不要提任何建议。`;

/* =========================================================
   三. 辩论专属参数模块 —— 仅反驳助手读取 (Bug7 / Bug9 / Bug11)
   受骂模式的任何代码路径都不允许引用本模块
   ========================================================= */

const DEBATE_PARAMS = {
  /* 反驳强度三档 */
  levels: [
    {
      name: "温和辩论",
      tip: "先接住再问一句, 立场不退",
      temperature: 0.6,
      prompt: "力度: 温和. 先接住他那句有道理的话, 再挑最要紧的一两点往下问, 语气像朋友在劝, 但立场不让.",
    },
    {
      name: "普通反驳",
      tip: "直接把不同意见摆上桌",
      temperature: 0.8,
      prompt: "力度: 普通. 直接说清你不认同哪一点, 顺着他的话往下拆, 把代价和漏洞讲透, 语气平静但不松口.",
    },
    {
      name: "强力抬杠",
      tip: "火力全开, 寸步不让",
      temperature: 0.95,
      prompt: "力度: 强力. 上来就顶住他最关键的那个假设, 连着追问两三个不好回答的问题, 句子短、有火气, 但讲逻辑, 不骂人.",
    },
  ],
  defaultIndex: 1,
  /* 防书面腔 / 防分点的表达约束 (Bug11) */
  styleRules: [
    "像真人当面争论, 不要写报告, 不要写论文腔.",
    "绝对不要分点罗列: 不要 第一/第二/第三, 不要 1. 2. 3., 不要 首先/其次/最后/综上所述.",
    "句子长短交错, 可以用反问、可以用短促的打断句, 可以说 这话我不认.",
    "直接针对他这次说的那句话里最具体的那个点开火, 别复述他的原话, 别讲空泛的道理.",
    "每次只写 3 到 5 句, 最多两段, 说完就停, 不要客套收尾.",
  ],
};

/* =========================================================
   四. 受骂专属参数模块 —— 仅受骂模式读取 (Bug7 / Bug8 / Bug12 / Bug13)
   反驳助手的任何代码路径都不允许引用本模块
   ========================================================= */

const VENT_PARAMS = {
  /* 硬性底线: 未满 10 轮发言绝不判定结束 (Bug3 / Bug8) */
  minRounds: 10,
  /* 10 轮之后, 压力达到该值才结束 */
  pressureThreshold: 90,
  /* 受骂模式固定温度, 与反驳强度无关 */
  temperature: 0.7,
  /* 结局收尾温度 */
  endingTemperature: 0.7,

  /* 按轮次分段的语气状态 (Bug12) */
  phases: [
    {
      id: "calm",
      range: "第 1-3 轮",
      title: "心态平和, 包容倾听",
      tone: "语气平缓, 句子长短适中, 像在认真听, 偶尔应一句. 心里有一点委屈, 但你不说, 也不解释.",
    },
    {
      id: "heavy",
      range: "第 4-6 轮",
      title: "内心开始压抑",
      tone: "话开始变短, 一句一句往外挤, 带出一点委屈和不解, 但仍旧只是承接, 不辩, 不认错.",
    },
    {
      id: "worn",
      range: "第 7-9 轮",
      title: "疲惫无力, 情绪紧绷",
      tone: "话很少, 常常只有一两个短句, 像被压得抬不起头, 累, 绷着, 却依然不认错, 也不回怼.",
    },
    {
      id: "edge",
      range: "第 10 轮",
      title: "情绪抵达临界点",
      tone: "回答压到最短, 像硬撑着等这件事结束; 这一轮仍然不可以认错, 只把最后那点力气用在接住他的话上.",
    },
  ],

  /* 压力词表: 只用于本地打分, 不参与生成回复 */
  words: [
    { score: 8, list: ["废物", "垃圾", "恶心", "滚", "闭嘴", "有病", "蠢", "白痴", "受够了", "忍无可忍", "失望透顶", "恶心透顶", "气死我了"] },
    { score: 4, list: ["讨厌", "烦人", "烦死", "过分", "凭什么", "无语", "失望", "你怎么", "你懂什么", "从来不", "总是", "明明", "抱怨", "指责"] },
    { score: 2, list: ["不太", "有点", "为什么", "不理解", "难受", "不舒服", "委屈", "累", "烦", "可惜", "算了"] },
  ],

  /* 全程硬约束: 对话中途绝不认错 (Bug13) */
  noConfessRule: "重要: 现在还在对话过程中, 轮次没有走完. 你心里有委屈, 只是默默承受. " +
    "绝对不可以认错, 不可以道歉, 不可以说 是我的错, 不可以说 对不起, 不可以说 我改. " +
    "就算对方骂得再重, 也只能接住, 不能低头.",
};

/* ==================== 五. 安全的 localStorage 读写 ==================== */

function safeGet(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

function safeSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
}

function safeRemove(key) {
  try { localStorage.removeItem(key); } catch (e) {}
}

/**
 * 历史对话结构校验 (Bug5)
 * 必须是数组, 首条 system, 其余 role 合法且 content 为非空字符串
 */
function isValidHistory(arr) {
  if (!Array.isArray(arr) || !arr.length) return false;
  const first = arr[0];
  if (!first || typeof first !== "object") return false;
  if (first.role !== "system" || typeof first.content !== "string") return false;
  for (let i = 1; i < arr.length; i++) {
    const m = arr[i];
    if (!m || typeof m !== "object") return false;
    if (m.role !== "user" && m.role !== "assistant") return false;
    if (typeof m.content !== "string" || m.content === "") return false;
  }
  return true;
}

/** 读取会话, 数据损坏自动清空重置 (Bug5) */
function readHistory(key, systemText) {
  const raw = safeGet(key);
  if (!raw) return [{ role: "system", content: systemText }];

  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }

  if (!isValidHistory(parsed)) {
    console.warn("[DDH] 本地对话数据异常, 已自动重置:", key);
    safeRemove(key);
    return [{ role: "system", content: systemText }];
  }

  /* 首条 system 一律替换成当前模式人设, 从根上杜绝串岗 (Bug1) */
  parsed[0] = { role: "system", content: systemText };
  return parsed;
}

function writeHistory(key, history) {
  try { safeSet(key, JSON.stringify(history)); } catch (e) {}
}

/* ==================== 六. 设置读取兼容层 ==================== */

function readSettingsRaw() {
  try {
    const obj = JSON.parse(safeGet("ddh:settings") || "{}");
    return obj && typeof obj === "object" ? obj : {};
  } catch (e) {
    safeRemove("ddh:settings");
    return {};
  }
}

function getSetting(key, def) {
  if (window.DDHStore && DDHStore.Settings) {
    try {
      const v = DDHStore.Settings.get(key);
      if (v !== undefined && v !== null) return v;
    } catch (e) {}
  }
  const raw = readSettingsRaw();
  return raw[key] === undefined || raw[key] === null ? def : raw[key];
}

function setSetting(key, value) {
  if (window.DDHStore && DDHStore.Settings) {
    try { DDHStore.Settings.set(key, value); return; } catch (e) {}
  }
  const raw = readSettingsRaw();
  raw[key] = value;
  safeSet("ddh:settings", JSON.stringify(raw));
}

/** 当前模式: debate(反驳助手) 或 vent(受骂模式) */
function getMode() {
  if (window.DDHStore && DDHStore.Settings) {
    try { return DDHStore.Settings.get("mode") === "vent" ? "vent" : "debate"; } catch (e) {}
  }
  const raw = readSettingsRaw();
  if (raw.mode === "vent") return "vent";
  return document.body.classList.contains("mode-vent") ? "vent" : "debate";
}

function isDebateMode() { return getMode() !== "vent"; }
function isVentMode() { return getMode() === "vent"; }

/** API Key 只从本机设置读取, 源码里没有硬编码密钥 */
function getApiKey() {
  return String(getSetting("apiKey", "") || "").trim();
}

/* ==================== 七. 背景设定读写 (Bug6 / Bug10) ==================== */

function loadCharacterBg() {
  const raw = safeGet(VENT_BG_KEY);
  if (!raw) return { target: "", bio: "" };

  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }

  if (parsed && typeof parsed === "object") {
    return {
      target: typeof parsed.target === "string" ? parsed.target : "",
      bio: typeof parsed.bio === "string" ? parsed.bio : "",
    };
  }

  if (typeof raw === "string" && raw.trim() && raw.charAt(0) !== "{") {
    return { target: "", bio: raw };
  }

  console.warn("[DDH] 背景设定数据异常, 已重置:", VENT_BG_KEY);
  safeRemove(VENT_BG_KEY);
  return { target: "", bio: "" };
}

function saveCharacterBg(target, bio) {
  return safeSet(VENT_BG_KEY, JSON.stringify({
    target: String(target == null ? "" : target).slice(0, 200),
    bio: String(bio == null ? "" : bio).slice(0, 2000),
  }));
}

/* ==================== 八. 受骂模式压力与状态 ==================== */

function scorePressure(text) {
  const str = String(text || "");
  if (!str) return 1;

  let score = 1;
  for (let i = 0; i < VENT_PARAMS.words.length; i++) {
    const group = VENT_PARAMS.words[i];
    for (let j = 0; j < group.list.length; j++) {
      if (str.indexOf(group.list[j]) >= 0) score += group.score;
    }
  }

  const marks = (str.match(/[!！?？]/g) || []).length;
  score += Math.min(4, marks * 1.5);
  score += Math.min(3, Math.floor(str.length / 40));

  return Math.max(1, Math.min(20, Math.round(score)));
}

/** 第几轮属于哪一段语气 (Bug12) */
function ventPhaseOf(round) {
  const r = Number(round) || 1;
  if (r <= 3) return VENT_PARAMS.phases[0];
  if (r <= 6) return VENT_PARAMS.phases[1];
  if (r <= 9) return VENT_PARAMS.phases[2];
  return VENT_PARAMS.phases[3];
}

/** 受骂模式运行状态, 与辩论模式完全无关 */
let ventState = { rounds: 0, pressure: 0, gameOver: false };

function isValidVentState(s) {
  return !!s && typeof s === "object" &&
    typeof s.rounds === "number" && isFinite(s.rounds) && s.rounds >= 0 && s.rounds < 10000 &&
    typeof s.pressure === "number" && isFinite(s.pressure) && s.pressure >= 0 && s.pressure < 100000 &&
    typeof s.gameOver === "boolean";
}

function loadVentState() {
  let parsed = null;
  try { parsed = JSON.parse(safeGet(VENT_STATE_KEY) || "null"); } catch (e) { parsed = null; }

  if (!isValidVentState(parsed)) {
    if (safeGet(VENT_STATE_KEY)) {
      console.warn("[DDH] 受骂模式状态数据异常, 已重置");
      safeRemove(VENT_STATE_KEY);
    }
    const hist = readHistory(VENT_CHAT_KEY, VENT_SYSTEM_PROMPT);
    const used = hist.filter(function (m) { return m.role === "user"; }).length;
    return { rounds: Math.min(used, VENT_PARAMS.minRounds - 1), pressure: 0, gameOver: false };
  }

  return { rounds: parsed.rounds, pressure: parsed.pressure, gameOver: parsed.gameOver };
}

function saveVentState() {
  safeSet(VENT_STATE_KEY, JSON.stringify(ventState));
}

/** 重置受骂状态: 回合 / 压力 / gameOver (Bug2) */
function resetVentState() {
  ventState = { rounds: 0, pressure: 0, gameOver: false };
  saveVentState();

  if (userInput) userInput.disabled = false;
  if (sendButton) sendButton.disabled = false;

  /* Bug6 / Bug10: 背景面板按钮永远保持可点 */
  forceBgToggleEnabled();

  renderVentMeter();
}

/* ==================== 九. DOM 引用 ==================== */

const chatArea = document.getElementById("chatArea");
const userInput = document.getElementById("userInput");
const sendButton = document.getElementById("sendButton");
const clearButton = document.getElementById("clearButton");

const roundCountEl = document.getElementById("roundCount");
const msgCountEl = document.getElementById("msgCount");
const strengthValueEl = document.getElementById("strengthValue");
const strengthSlider = document.getElementById("strengthSlider");
const strengthTip = document.getElementById("strengthTip");
const strengthLabels = document.getElementById("strengthLabels");
const themeToggle = document.getElementById("themeToggle");
const themeIcon = document.getElementById("themeIcon");
const themeColorMeta = document.getElementById("themeColorMeta");

/* ==================== 十. 运行状态 ==================== */

let chatHistory = [];
let isThinking = false;
let isClearing = false;
let sessionEpoch = 0;
let engineReady = false;
let bgPanelOpen = false;

/* 反驳强度下标: 只属于辩论模块 (Bug7) */
let currentStrength = (function () {
  let saved = NaN;
  try { saved = parseInt(safeGet(STRENGTH_KEY), 10); } catch (e) {}
  return Number.isInteger(saved) && saved >= 0 && saved < DEBATE_PARAMS.levels.length
    ? saved
    : DEBATE_PARAMS.defaultIndex;
})();

const IS_TOUCH = (function () {
  try { return window.matchMedia("(hover: none) and (pointer: coarse)").matches; } catch (e) { return false; }
})();

function currentSessionKey() {
  return isVentMode() ? VENT_CHAT_KEY : DEBATE_CHAT_KEY;
}

function currentSystemPrompt() {
  return isVentMode() ? VENT_SYSTEM_PROMPT : DEBATE_SYSTEM_PROMPT;
}

function loadSession() {
  return readHistory(currentSessionKey(), currentSystemPrompt());
}

function saveSession(history) {
  writeHistory(currentSessionKey(), history);
}

/* ==================== 十一. 通用工具 ==================== */

function escapeHtml(text) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(text == null ? "" : text).replace(/[&<>"']/g, function (ch) { return map[ch]; });
}

function formatReply(text) {
  let safeText = escapeHtml(text);
  safeText = safeText.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  safeText = safeText.replace(/\n+/g, "<br>");
  return safeText;
}

function scrollToBottom(smooth) {
  if (!chatArea) return;
  const doScroll = function () {
    if (smooth && typeof chatArea.scrollTo === "function") {
      try {
        chatArea.scrollTo({ top: chatArea.scrollHeight, behavior: "smooth" });
        return;
      } catch (e) {}
    }
    chatArea.scrollTop = chatArea.scrollHeight;
  };
  doScroll();
  window.requestAnimationFrame(doScroll);
}

function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

let toastTimer = null;

function showToast(text, duration) {
  let el = document.getElementById("appToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "appToast";
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = text;
  void el.offsetWidth;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove("show"); }, duration || 1800);
}

function bump(el) {
  if (!el) return;
  el.classList.remove("bump");
  void el.offsetWidth;
  el.classList.add("bump");
  setTimeout(function () { el.classList.remove("bump"); }, 600);
}

function pickEmoji() {
  return AI_EMOJIS[Math.floor(Math.random() * AI_EMOJIS.length)];
}

function fmtTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  function p(n) { return n < 10 ? "0" + n : "" + n; }
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
    " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

function copyText(text) {
  const str = String(text == null ? "" : text);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(str).then(function () {
      showToast("已复制到剪贴板", 1200);
    }).catch(function () { fallbackCopy(str); });
  }
  fallbackCopy(str);
  return Promise.resolve();
}

function fallbackCopy(str) {
  try {
    const ta = document.createElement("textarea");
    ta.value = str;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, str.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    showToast(ok ? "已复制到剪贴板" : "复制失败, 请长按选择", 1600);
  } catch (e) {
    showToast("复制失败, 请长按选择", 1600);
  }
}

/* ==================== 十二. 自建弹窗系统 ==================== */

let appModalBound = false;

function ensureModalRoot() {
  let root = document.getElementById("modalRoot");
  if (!root) {
    root = document.createElement("div");
    root.id = "modalRoot";
    root.className = "modal";
    root.hidden = true;
    root.innerHTML =
      '<div class="modal-mask" data-close-modal="1"></div>' +
      '<div class="modal-panel" role="dialog" aria-modal="true">' +
      '<div class="modal-head"><strong id="modalTitle"></strong>' +
      '<button class="icon-btn" type="button" id="modalClose" aria-label="关闭">X</button></div>' +
      '<div class="modal-body" id="modalBody"></div>' +
      '<div class="modal-actions" id="modalActions"></div>' +
      "</div>";
    document.body.appendChild(root);
  }

  if (!root.querySelector("#modalBody")) {
    root.innerHTML =
      '<div class="modal-mask" data-close-modal="1"></div>' +
      '<div class="modal-panel" role="dialog" aria-modal="true">' +
      '<div class="modal-head"><strong id="modalTitle"></strong>' +
      '<button class="icon-btn" type="button" id="modalClose" aria-label="关闭">X</button></div>' +
      '<div class="modal-body" id="modalBody"></div>' +
      '<div class="modal-actions" id="modalActions"></div>' +
      "</div>";
  }

  if (!appModalBound) {
    appModalBound = true;
    root.addEventListener("click", function (e) {
      const t = e.target;
      if (!t || !t.hasAttribute) return;
      if (t.hasAttribute("data-close-modal") || t.hasAttribute("data-app-modal-close") || t.id === "modalClose") {
        closeAppModal();
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeAppModal();
    });
  }

  return root;
}

function freshModalBody() {
  const old = document.getElementById("modalBody");
  if (!old || !old.parentNode) return null;
  const clone = old.cloneNode(false);
  clone.innerHTML = "";
  old.parentNode.replaceChild(clone, old);
  return clone;
}

function renderModalActions(actions) {
  const box = document.getElementById("modalActions");
  if (!box) return;
  box.innerHTML = "";
  (actions || []).forEach(function (a) {
    if (!a) return;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mini-btn" + (a.primary ? " primary" : "");
    b.textContent = a.label || "确定";
    b.addEventListener("click", function () {
      if (typeof a.onClick === "function") a.onClick();
      else closeAppModal();
    });
    box.appendChild(b);
  });
}

function openAppModal(title, bodyHtml, actions) {
  const root = ensureModalRoot();
  const titleEl = root.querySelector("#modalTitle");
  if (titleEl) titleEl.textContent = title || "";

  const bodyEl = freshModalBody();
  if (bodyEl && bodyHtml != null) bodyEl.innerHTML = bodyHtml;

  renderModalActions(actions || [{ label: "关闭", primary: true, onClick: closeAppModal }]);

  root.hidden = false;
  root.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");

  const body = document.getElementById("modalBody");
  if (body) body.scrollTop = 0;
  return root;
}

function closeAppModal() {
  const root = document.getElementById("modalRoot");
  if (!root) return;
  root.hidden = true;
  root.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function setAppModalBody(html) {
  const el = document.getElementById("modalBody");
  if (el) el.innerHTML = html;
}

function setAppModalActions(actions) {
  renderModalActions(actions);
}

/* ==================== 十三. 头像 (功能保留) ==================== */

const AVATAR_PRESETS = [
  { id: "scholar", name: "学者", char: "学", color: "#2563eb" },
  { id: "roast", name: "杠精", char: "杠", color: "#ef4444" },
  { id: "humor", name: "吐槽", char: "吐", color: "#f59e0b" },
  { id: "examiner", name: "考官", char: "考", color: "#0ea5e9" },
  { id: "judge", name: "法官", char: "判", color: "#7c3aed" },
  { id: "rival", name: "对手", char: "对", color: "#10b981" },
];

function shadeColor(hex, percent) {
  const num = parseInt(String(hex).replace("#", ""), 16);
  if (isNaN(num)) return hex;
  const amt = Math.round(2.55 * percent);
  let r = (num >> 16) + amt;
  let g = ((num >> 8) & 0x00ff) + amt;
  let b = (num & 0x0000ff) + amt;
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

function makeAvatarDataUrl(char, color) {
  const size = 128;
  const cv = document.createElement("canvas");
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext("2d");

  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, color);
  grad.addColorStop(1, shadeColor(color, -35));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fill();

  try {
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 64px -apple-system, PingFang SC, Microsoft YaHei, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(char, size / 2, size / 2 + 2);
  } catch (e) {}

  return cv.toDataURL("image/png");
}

function getStoredAvatar() {
  if (window.DDHStore && DDHStore.Avatars) {
    try { return DDHStore.Avatars.image() || ""; } catch (e) {}
  }
  return safeGet("ddh:avatar") || "";
}

function setStoredAvatar(url) {
  if (window.DDHStore && DDHStore.Avatars) {
    try {
      if (url) DDHStore.Avatars.set(url);
      else DDHStore.Avatars.reset();
      return;
    } catch (e) {}
  }
  if (url) safeSet("ddh:avatar", url);
  else safeRemove("ddh:avatar");
}

function applyAvatarTo(el, role) {
  if (!el) return;

  if (role === "error") {
    el.textContent = "!";
    el.style.backgroundImage = "";
    el.classList.remove("has-image");
    return;
  }
  if (role === "user") {
    el.textContent = "我";
    el.style.backgroundImage = "";
    el.classList.remove("has-image");
    return;
  }

  const img = getStoredAvatar();
  if (img) {
    el.textContent = "";
    el.style.backgroundImage = 'url("' + img + '")';
    el.classList.add("has-image");
  } else {
    el.textContent = isVentMode() ? "受" : "驳";
    el.style.backgroundImage = "";
    el.classList.remove("has-image");
  }
}

function refreshAiAvatars() {
  if (!chatArea) return;
  const nodes = chatArea.querySelectorAll(".message .avatar");
  for (let i = 0; i < nodes.length; i++) {
    const msg = nodes[i].parentNode;
    let role = "assistant";
    if (msg && msg.classList) {
      if (msg.classList.contains("user")) role = "user";
      else if (msg.classList.contains("error")) role = "error";
    }
    applyAvatarTo(nodes[i], role);
  }
}

function buildAvatarPickerHtml() {
  let html = '<div class="hint">点一下就能换掉对方的头像, 也可以上传自己的图片.</div>';
  html += '<div class="avatar-picker">';
  AVATAR_PRESETS.forEach(function (p, i) {
    if (!p.data) p.data = makeAvatarDataUrl(p.char, p.color);
    html += '<button class="avatar-opt" type="button" data-av="' + i + '">' +
      '<img src="' + p.data + '" alt="' + p.name + '" />' +
      "<span>" + p.name + "</span></button>";
  });
  html += "</div>";
  html += '<div class="row" style="margin-top:12px">' +
    '<button class="mini-btn" type="button" id="avUpload">上传自己的图片</button>' +
    '<button class="mini-btn" type="button" id="avReset">恢复默认文字头像</button>' +
    "</div>";
  html += '<input type="file" id="avFile" accept="image/*" hidden />';
  return html;
}

function openAvatarPicker() {
  openAppModal("🖼️ 切换对方头像", buildAvatarPickerHtml(), [
    { label: "关闭", primary: true, onClick: closeAppModal },
  ]);
  bindAvatarModalOnce();
}

let avatarModalBound = false;

function bindAvatarModalOnce() {
  const bodyEl = document.getElementById("modalBody");
  if (!bodyEl) return;
  if (bodyEl.dataset.avBound === "1") return;
  bodyEl.dataset.avBound = "1";

  bodyEl.addEventListener("click", function (e) {
    const t = e.target;
    if (!t || !t.closest) return;

    const opt = t.closest("[data-av]");
    if (opt) {
      const idx = Number(opt.getAttribute("data-av"));
      const preset = AVATAR_PRESETS[idx];
      if (!preset) return;
      if (!preset.data) preset.data = makeAvatarDataUrl(preset.char, preset.color);
      setStoredAvatar(preset.data);
      refreshAiAvatars();
      showToast("头像已换成 " + preset.name, 1400);
      closeAppModal();
      return;
    }

    if (t.id === "avUpload") {
      const file = document.getElementById("avFile");
      if (file) file.click();
      return;
    }

    if (t.id === "avReset") {
      setStoredAvatar("");
      refreshAiAvatars();
      showToast("已恢复默认文字头像", 1600);
      closeAppModal();
    }
  });

  bodyEl.addEventListener("change", function (e) {
    const input = e.target;
    if (!input || input.id !== "avFile") return;
    const file = input.files && input.files[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      showToast("请选择图片文件", 1600);
      return;
    }

    const reader = new FileReader();
    reader.onload = function () {
      const img = new Image();
      img.onload = function () {
        try {
          const size = 192;
          const cv = document.createElement("canvas");
          cv.width = size;
          cv.height = size;
          const ctx = cv.getContext("2d");
          const side = Math.min(img.width, img.height);
          const sx = (img.width - side) / 2;
          const sy = (img.height - side) / 2;

          ctx.save();
          ctx.beginPath();
          ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
          ctx.closePath();
          ctx.clip();
          ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
          ctx.restore();

          setStoredAvatar(cv.toDataURL("image/jpeg", 0.82));
          refreshAiAvatars();
          showToast("头像已保存, 已自动圆形裁切", 1500);
          closeAppModal();
        } catch (err) {
          showToast("图片处理失败, 换一张试试", 1800);
        }
      };
      img.onerror = function () { showToast("图片读取失败", 1600); };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ==================== 十四. 消息渲染 ==================== */

function appendMessage(role, html, options) {
  const opts = options || {};

  const wrapper = document.createElement("div");
  wrapper.className = "message " + role;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  applyAvatarTo(avatar, role);
  if (role === "assistant") avatar.setAttribute("title", "点这里更换对方头像");

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = html;

  if (role === "assistant" && opts.emoji !== false) {
    const emoji = document.createElement("span");
    emoji.className = "emoji-pop";
    emoji.setAttribute("aria-hidden", "true");
    emoji.textContent = pickEmoji();
    bubble.appendChild(emoji);
  }

  if (role === "user" || role === "assistant") {
    const favBtn = document.createElement("button");
    favBtn.type = "button";
    favBtn.className = "fav-btn";
    favBtn.textContent = "☆";
    favBtn.setAttribute("aria-label", "收藏这条消息");
    favBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      const raw = opts.text != null ? String(opts.text) : bubble.textContent;
      let ok = false;
      if (window.DDHStore && DDHStore.Favorites) {
        try { ok = DDHStore.Favorites.add({ role: role, text: raw, mode: getMode() }); } catch (e) {}
      } else {
        let arr = [];
        try { arr = JSON.parse(safeGet("ddh:favorites") || "[]"); } catch (e) { arr = []; }
        if (!Array.isArray(arr)) arr = [];
        if (!arr.some(function (f) { return f && f.text === raw; })) {
          arr.unshift({ id: String(Date.now()), role: role, text: raw, mode: getMode(), ts: Date.now() });
          safeSet("ddh:favorites", JSON.stringify(arr.slice(0, 300)));
          ok = true;
        }
      }
      favBtn.textContent = ok ? "⭐" : "★";
      showToast(ok ? "已收藏这条消息" : "这条消息已经收藏过了", 1400);
    });
    wrapper.appendChild(favBtn);
  }

  wrapper.appendChild(avatar);
  wrapper.appendChild(bubble);
  chatArea.appendChild(wrapper);

  scrollToBottom();
  return wrapper;
}

function appendThinkingMessage() {
  const wrapper = document.createElement("div");
  wrapper.className = "message assistant thinking";
  wrapper.id = "thinkingMessage";

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  applyAvatarTo(avatar, "assistant");

  const text = isVentMode() ? "正在承受这些话..." : "正在构思反驳观点...";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML =
    '<span class="thinking-text">' + text + '</span>' +
    '<span class="thinking-dots"><span></span><span></span><span></span></span>';

  wrapper.appendChild(avatar);
  wrapper.appendChild(bubble);
  chatArea.appendChild(wrapper);
  scrollToBottom();

  return wrapper;
}

function removeThinkingMessage() {
  const thinking = document.getElementById("thinkingMessage");
  if (thinking) thinking.remove();
}

function setLoading(loading) {
  isThinking = loading;
  if (userInput) userInput.disabled = loading;
  if (sendButton) {
    sendButton.disabled = loading;
    sendButton.textContent = loading ? "思考中..." : "提交";
  }
  const card = document.getElementById("statsCard");
  if (card) card.classList.toggle("is-busy", loading);

  /* Bug10: 无论什么状态, 背景按钮都不许被禁用 */
  forceBgToggleEnabled();
}

/* ==================== 十五. 主题 ==================== */

function applyTheme(theme, persist) {
  const t = theme === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", t);

  if (themeIcon) themeIcon.textContent = t === "dark" ? "☀️" : "🌙";
  if (themeToggle) {
    const label = t === "dark" ? "切换到浅色主题" : "切换到暗黑主题";
    themeToggle.setAttribute("aria-label", label);
    themeToggle.setAttribute("title", label);
    themeToggle.setAttribute("aria-pressed", t === "dark" ? "true" : "false");
  }
  if (themeColorMeta) themeColorMeta.setAttribute("content", THEME_COLORS[t]);

  if (persist !== false) safeSet(THEME_KEY, t);
}

function initTheme() {
  const saved = safeGet(THEME_KEY);
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (prefersDark ? "dark" : "light"), false);
}

function toggleTheme() {
  const now = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(now, true);
  showToast(now === "dark" ? "已切换到暗黑模式" : "已切换到浅色模式", 1200);
}

/* =========================================================
   十六. 反驳强度 —— 只属于辩论模式 (Bug7)
   ========================================================= */

function getStrengthLevel() {
  if (!isDebateMode()) {
    return DEBATE_PARAMS.levels[DEBATE_PARAMS.defaultIndex];
  }
  return DEBATE_PARAMS.levels[currentStrength] || DEBATE_PARAMS.levels[DEBATE_PARAMS.defaultIndex];
}

function setStrength(index, options) {
  const opts = options || {};
  if (!isDebateMode()) return; /* 受骂模式禁用反驳强度 */

  const raw = Number(index);
  const i = Math.max(0, Math.min(DEBATE_PARAMS.levels.length - 1, isNaN(raw) ? DEBATE_PARAMS.defaultIndex : raw));

  currentStrength = i;
  const level = DEBATE_PARAMS.levels[i];

  if (strengthSlider && String(strengthSlider.value) !== String(i)) strengthSlider.value = String(i);
  if (strengthSlider) strengthSlider.setAttribute("aria-valuetext", level.name);
  if (strengthTip) strengthTip.textContent = level.tip;
  if (strengthValueEl) strengthValueEl.textContent = level.name;

  if (strengthLabels) {
    const labels = strengthLabels.querySelectorAll("[data-level]");
    for (let k = 0; k < labels.length; k++) {
      labels[k].classList.toggle("active", Number(labels[k].getAttribute("data-level")) === i);
    }
  }

  if (opts.persist !== false) safeSet(STRENGTH_KEY, String(i));
  if (opts.silent !== true && strengthValueEl) bump(strengthValueEl);
}

function initStrength() {
  if (!isDebateMode()) return;
  setStrength(currentStrength, { persist: false, silent: true });
}

/* =========================================================
   十七. 辩论统计 —— 只属于辩论模式 (Bug7 / Bug9)
   ========================================================= */

function updateStats(animate) {
  if (!isDebateMode()) return;

  const rounds = chatHistory.filter(function (m) { return m.role === "assistant"; }).length;
  const mine = chatHistory.filter(function (m) { return m.role === "user"; }).length;

  if (roundCountEl) roundCountEl.textContent = String(rounds);
  if (msgCountEl) msgCountEl.textContent = String(mine);
  if (strengthValueEl) strengthValueEl.textContent = getStrengthLevel().name;

  if (animate) {
    bump(roundCountEl);
    bump(msgCountEl);
  }
}

/* ==================== 十八. 调用接口 ==================== */

async function callDeepSeek(messages, temperature) {
  if (!navigator.onLine) {
    throw new Error("当前网络不可用, 只能查看历史记录, 联网后才能发起新对话");
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("还没有填写 API Key, 点右上角设置按钮, 填入 DeepSeek 密钥后再试");
  }

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
  const temp = typeof temperature === "number" ? temperature : 0.7;

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: messages,
        temperature: temp,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const status = response.status;
      if (status === 401) throw new Error("API Key 无效, 请到右上角设置面板重新填写");
      else if (status === 402) throw new Error("账户余额不足, 请前往 platform.deepseek.com 充值");
      else if (status === 429) throw new Error("请求过于频繁, 请稍后再试");
      else throw new Error("接口返回错误 HTTP " + status);
    }

    const data = await response.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";

    if (!content || typeof content !== "string" || !content.trim()) {
      throw new Error("接口未返回有效内容");
    }
    return content.trim();
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时, 请检查网络后重试");
    if (error instanceof TypeError) throw new Error("网络请求失败, 请检查网络连接");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   十九. 两套提示词构建 —— 严格隔离 (Bug1 / Bug6 / Bug7 / Bug11~13)
   ========================================================= */

/** 只给受骂模式用: 读取背景设定 */
function readVentProfile() {
  const targetEl = document.getElementById("bgTarget");
  const bioEl = document.getElementById("bgBio");

  let target = targetEl && typeof targetEl.value === "string" ? targetEl.value.trim() : "";
  let bio = bioEl && typeof bioEl.value === "string" ? bioEl.value.trim() : "";

  if (!target || !bio) {
    const stored = loadCharacterBg();
    if (!target) target = stored.target;
    if (!bio) bio = stored.bio;
  }

  return { target: target, bio: bio };
}

/** 反驳助手提示词: 只用辩论参数, 绝不读背景文本 (Bug11) */
function buildDebatePrompt() {
  const level = DEBATE_PARAMS.levels[currentStrength] || DEBATE_PARAMS.levels[DEBATE_PARAMS.defaultIndex];
  const lines = [];
  lines.push(DEBATE_SYSTEM_PROMPT);
  lines.push("");
  lines.push("本次" + level.prompt);
  lines.push("");
  lines.push("【说话方式, 比上面所有要求都重要】");
  DEBATE_PARAMS.styleRules.forEach(function (rule) { lines.push("- " + rule); });
  lines.push("");
  lines.push("对话中始终扮演反驳助手: 只做理性反驳, 不安慰, 不示弱, 不认错, 不结束对话, 不判定结局.");
  return lines.join("\n");
}

/** 受骂模式提示词: 只用受骂参数与背景文本, 绝不读反驳强度 (Bug12 / Bug13) */
function buildVentPrompt() {
  const profile = readVentProfile();
  const round = Math.max(ventState.rounds, 1);
  const phase = ventPhaseOf(round);

  const lines = [];
  lines.push(VENT_SYSTEM_PROMPT);
  lines.push("");
  lines.push("角色背景设定: " + (profile.bio ? profile.bio : "用户没有填写背景, 按一个普通的、和用户有点矛盾的人来演."));
  if (profile.target) lines.push("你面对的人是谁: " + profile.target);
  lines.push("");
  lines.push("【本轮情绪状态】轮次 " + round + " / " + VENT_PARAMS.minRounds + " , 落在 " + phase.range);
  lines.push("状态: " + phase.title);
  lines.push("语感要求: " + phase.tone);
  lines.push("你的语气要跟着轮次一点点沉下去, 不能从头到尾一个腔调.");
  lines.push("");
  lines.push("【本轮累计压力】" + ventState.pressure + " 分, 阈值 " + VENT_PARAMS.pressureThreshold + " 分, 仅你内部参考, 不要向用户报数字.");
  lines.push("");
  lines.push("【不可违反】");
  lines.push(VENT_PARAMS.noConfessRule);
  lines.push("现在只是第 " + round + " 轮, 远没到结局, 不要主动收场, 不要说 结束吧 / 就这样吧.");
  lines.push("");
  lines.push("写作要求: 只写 1 到 3 句口语化的短回应, 顺着用户这句话里最具体的地方承接, 不复述原话, 不给建议, 不说教.");
  return lines.join("\n");
}

/** 结局收尾提示词: 只有这一刻才允许认错 (Bug13) */
function buildVentEndingPrompt() {
  const profile = readVentProfile();
  const lines = [];
  lines.push(VENT_ENDING_SYSTEM_PROMPT);
  lines.push("");
  if (profile.bio) lines.push("角色背景设定: " + profile.bio);
  if (profile.target) lines.push("你面对的人是谁: " + profile.target);
  lines.push("");
  lines.push("已经承受满 " + ventState.rounds + " 轮, 累计压力 " + ventState.pressure + " 分.");
  lines.push("现在只说 1 到 2 句: 承认是自己的问题, 说一句对不起, 不要解释, 不要找理由, 不要安慰, 不要给建议.");
  return lines.join("\n");
}

/** 按模式二选一, system 提示词绝不混用 (Bug1) */
function buildRequestMessages() {
  const sys = isVentMode() ? buildVentPrompt() : buildDebatePrompt();

  const history = chatHistory.filter(function (m) {
    return m.role === "user" || m.role === "assistant";
  });
  const recent = history.length > 24 ? history.slice(-24) : history;

  const out = [{ role: "system", content: sys }];
  recent.forEach(function (m) { out.push({ role: m.role, content: m.content }); });
  return out;
}

/* ==================== 二十. 提交 ==================== */

async function handleSubmit() {
  if (isThinking || isClearing) return;

  const mode = getMode();
  const ventMode = mode === "vent";

  /* 只有受骂模式才检查锁局 (Bug9) */
  if (ventMode && ventState.gameOver) {
    showToast("本次结局已经结束, 点清空对话可以重新开始一场", 2200);
    return;
  }

  const rawText = userInput.value.trim();
  if (rawText === "") {
    userInput.focus();
    userInput.placeholder = "内容不能为空, 请输入你想说的话";
    return;
  }

  const epoch = sessionEpoch;

  chatHistory.push({ role: "user", content: rawText });
  saveSession(chatHistory);

  appendMessage("user", escapeHtml(rawText), { text: rawText });

  /* 压力与回合计数只属于受骂模式 (Bug7 / Bug9) */
  if (ventMode) {
    ventState.rounds = ventState.rounds + 1;
    ventState.pressure = ventState.pressure + scorePressure(rawText);
    saveVentState();
    renderVentMeter();
  }

  updateStats(true);

  userInput.value = "";
  userInput.placeholder = ventMode ? "继续说, 我听着" : "说出你的想法, 我来反驳";
  autoResizeInput();

  setLoading(true);
  appendThinkingMessage();

  /* 温度: 受骂模式用固定温度, 不读反驳强度 (Bug7) */
  const temperature = ventMode
    ? VENT_PARAMS.temperature
    : (DEBATE_PARAMS.levels[currentStrength] || DEBATE_PARAMS.levels[DEBATE_PARAMS.defaultIndex]).temperature;

  try {
    const reply = await callDeepSeek(buildRequestMessages(), temperature);
    if (epoch !== sessionEpoch) return;

    chatHistory.push({ role: "assistant", content: reply });
    saveSession(chatHistory);

    removeThinkingMessage();
    appendMessage("assistant", formatReply(reply), { text: reply, emoji: true });
    updateStats(true);

    /* 结局判定只在受骂模式执行 (Bug9) */
    if (ventMode) {
      await finalizeVentTurn();
      renderVentMeter();
    }
  } catch (error) {
    if (epoch !== sessionEpoch) return;
    removeThinkingMessage();
    appendMessage("error", "错误: " + escapeHtml(error.message));
  } finally {
    if (epoch === sessionEpoch) {
      setLoading(false);
      if (isVentMode() && ventState.gameOver && ventState.rounds >= VENT_PARAMS.minRounds) {
        lockVentSession();
      }
      if (!IS_TOUCH) userInput.focus();
      scrollToBottom(true);
    }
  }
}

/* =========================================================
   二十一. 受骂模式结局判定 —— 三重硬保护 (Bug3 / Bug8 / Bug9 / Bug13)
   ========================================================= */

/**
 * 是否具备结束资格, 必须全部满足:
 * 1. 当前是受骂模式 (辩论模式永远为 false)
 * 2. 尚未结束
 * 3. 用户发言轮次 >= 10 (硬性底线)
 * 4. 压力达到阈值
 */
function canEndVentSession() {
  if (!isVentMode()) return false;
  if (!ventState || ventState.gameOver) return false;
  if (ventState.rounds < VENT_PARAMS.minRounds) return false;
  if (ventState.pressure < VENT_PARAMS.pressureThreshold) return false;
  return true;
}

/** 结局时动态生成一句认错收尾, 生成失败就跳过, 绝不写死台词 (Bug4) */
async function requestVentEnding() {
  try {
    const history = chatHistory.filter(function (m) {
      return m.role === "user" || m.role === "assistant";
    }).slice(-12);

    const messages = [{ role: "system", content: buildVentEndingPrompt() }];
    history.forEach(function (m) { messages.push({ role: m.role, content: m.content }); });

    const reply = await callDeepSeek(messages, VENT_PARAMS.endingTemperature);
    return reply;
  } catch (err) {
    console.warn("[DDH] 结局收尾生成失败, 跳过:", err && err.message);
    return "";
  }
}

/** 执行结局判定, 不满足条件直接返回, 什么都不做 */
async function finalizeVentTurn() {
  if (!canEndVentSession()) return;

  ventState.gameOver = true;
  saveVentState();

  /* 轮次与压力先落地, 再把认错那句话说出口 */
  const closing = await requestVentEnding();
  if (closing && isVentMode()) {
    chatHistory.push({ role: "assistant", content: closing });
    saveSession(chatHistory);
    appendMessage("assistant", formatReply(closing), { text: closing, emoji: true });
  }

  renderGameOverCard(ventState.rounds, ventState.pressure);
  showToast("本次结局已经结束, 点清空对话可以重新开始一场", 2600);
}

/** 锁局: 只锁输入框与发送按钮, 背景面板按钮保持可点 (Bug6 / Bug10) */
function lockVentSession() {
  if (!isVentMode()) return;
  if (ventState.rounds < VENT_PARAMS.minRounds) return;

  if (userInput) {
    userInput.disabled = true;
    userInput.placeholder = "本次结局已经结束, 点清空对话可以重新开始一场";
  }
  if (sendButton) sendButton.disabled = true;

  forceBgToggleEnabled();
}

/** 结局卡片: 只放提示与数据, 不放任何写死的角色台词 (Bug4) */
function renderGameOverCard(rounds, pressure) {
  if (!isVentMode()) return;
  if (rounds < VENT_PARAMS.minRounds) return;

  const card = document.createElement("div");
  card.className = "ending-card";
  card.innerHTML =
    '<div class="ending-emoji">🫥</div>' +
    '<div class="ending-title">本局结束</div>' +
    '<div class="ending-text">' +
    "你一共说了 " + rounds + " 句, 累计压力 " + pressure + " 分." +
    "</div>" +
    '<div class="ending-actions"><span class="hint">本次结局已经结束, 点清空对话可以重新开始一场</span></div>';
  chatArea.appendChild(card);
  scrollToBottom();
}

/* ==================== 二十二. 背景按钮永久可点 (Bug10) ==================== */

/** 强制把背景展开按钮设为可点, 任何场景都调用一次 */
function forceBgToggleEnabled() {
  const btn = document.getElementById("bgToggleBtn");
  if (btn && btn.disabled) btn.disabled = false;
}

/** 监听 disabled 属性, 一旦被置为 true 立刻改回 false (Bug10) */
function guardBgToggle() {
  const btn = document.getElementById("bgToggleBtn");
  if (!btn) return;
  btn.disabled = false;

  if (btn.dataset.guarded !== "1") {
    btn.dataset.guarded = "1";

    btn.addEventListener("click", function () {
      if (btn.disabled) btn.disabled = false;
    });

    if (window.MutationObserver) {
      try {
        const mo = new MutationObserver(function () {
          if (btn.disabled) btn.disabled = false;
        });
        mo.observe(btn, { attributes: true, attributeFilter: ["disabled"] });
      } catch (e) {}
    }
  }
}

/* ==================== 二十三. 页面注入: 模式切换 / 背景面板 (Bug6 / Bug10) ==================== */

function mountVentFeatures() {
  if (document.getElementById("modeSwitch")) {
    restoreBgInputs();
    guardBgToggle();
    return;
  }

  const host = document.querySelector(".header");
  const toolbar = document.getElementById("toolStrip");

  /* 1. 模式切换条 */
  const switcher = document.createElement("div");
  switcher.className = "mode-tabs";
  switcher.id = "modeSwitch";
  switcher.style.padding = "8px 12px";
  switcher.style.background = "var(--color-surface)";
  switcher.style.borderBottom = "1px solid var(--color-border)";
  switcher.innerHTML =
    '<button class="mode-tab" type="button" data-mode="debate">反驳助手</button>' +
    '<button class="mode-tab" type="button" data-mode="vent">受骂模式</button>';

  /* 2. 背景展开按钮: 永不禁用 (Bug6 / Bug10) */
  const toggleRow = document.createElement("div");
  toggleRow.id = "bgToggleRow";
  toggleRow.style.padding = "6px 12px";
  toggleRow.style.background = "var(--color-surface)";
  toggleRow.style.borderBottom = "1px solid var(--color-border)";
  toggleRow.style.display = "flex";
  toggleRow.style.alignItems = "center";
  toggleRow.style.gap = "8px";
  toggleRow.innerHTML =
    '<button id="bgToggleBtn" class="mini-btn" type="button" aria-expanded="false" aria-controls="bgPanel">' +
    "展开：宣泄对象背景设置</button>" +
    '<span class="hint" style="margin:0" id="bgHint">两种模式都能编辑, 只有受骂模式会用到</span>';

  /* 3. 背景编辑面板 */
  const panel = document.createElement("div");
  panel.id = "bgPanel";
  panel.hidden = true;
  panel.style.padding = "8px 12px";
  panel.style.background = "var(--color-surface)";
  panel.style.borderBottom = "1px solid var(--color-border)";
  panel.innerHTML =
    '<label class="vent-field">' +
    '  <span class="field-label">宣泄对象 (可选)</span>' +
    '  <input id="bgTarget" class="field-input" type="text" placeholder="比如 室友 / 小组队友 / 家人" />' +
    '</label>' +
    '<label class="vent-field">' +
    '  <span class="field-label">角色背景人设</span>' +
    '  <textarea id="bgBio" class="field-input field-textarea" rows="3" placeholder="写下这个角色的背景: 你们什么关系, 他什么性格, 最近发生了什么"></textarea>' +
    '</label>' +
    '<div class="row" style="gap:8px">' +
    '  <button id="bgSaveBtn" class="mini-btn primary" type="button">保存背景设定</button>' +
    '  <button id="bgClearBtn" class="mini-btn" type="button">清空</button>' +
    '</div>';

  /* 4. 受骂模式进度条 (只在受骂模式显示) */
  const meterBox = document.createElement("div");
  meterBox.id = "ventMeterBox";
  meterBox.hidden = true;
  meterBox.style.padding = "0 12px 8px";
  meterBox.style.background = "var(--color-surface)";
  meterBox.innerHTML =
    '<div class="vent-progress-head"><span>承受进度</span><span id="ventMeterLabel">第 0 / 10 轮</span></div>' +
    '<div class="vent-bar-wrap" id="ventMeterWrap" data-stage="listen"><div class="vent-bar" id="ventMeterBar"></div></div>';

  const nodes = [switcher, toggleRow, panel, meterBox];
  nodes.forEach(function (n) { n.style.flex = "0 0 auto"; });

  if (host && host.parentNode) {
    let ref = host.nextSibling;
    nodes.forEach(function (n) {
      host.parentNode.insertBefore(n, ref);
      ref = n.nextSibling;
    });
  } else if (toolbar && toolbar.parentNode) {
    nodes.forEach(function (n) { toolbar.parentNode.insertBefore(n, toolbar); });
  } else {
    nodes.forEach(function (n) { document.body.appendChild(n); });
  }

  /* ---------- 事件 ---------- */

  switcher.addEventListener("click", function (e) {
    const btn = e.target && e.target.closest ? e.target.closest("[data-mode]") : null;
    if (!btn) return;
    setMode(btn.getAttribute("data-mode"));
  });

  /* Bug6 / Bug10: 展开收起按钮任何模式下都可点 */
  const toggleBtn = document.getElementById("bgToggleBtn");
  if (toggleBtn) {
    toggleBtn.disabled = false;
    toggleBtn.addEventListener("click", function () {
      toggleBgPanel(!bgPanelOpen);
    });
    guardBgToggle();
  }

  const saveBtn = document.getElementById("bgSaveBtn");
  if (saveBtn) {
    saveBtn.addEventListener("click", function () {
      const targetEl = document.getElementById("bgTarget");
      const bioEl = document.getElementById("bgBio");
      const ok = saveCharacterBg(targetEl ? targetEl.value : "", bioEl ? bioEl.value : "");
      showToast(ok ? "背景设定已保存" : "保存失败, 可能是存储空间不足", 1600);
      /* 保存后按钮依旧可点 */
      forceBgToggleEnabled();
    });
  }

  const clearBtn = document.getElementById("bgClearBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      const targetEl = document.getElementById("bgTarget");
      const bioEl = document.getElementById("bgBio");
      if (targetEl) targetEl.value = "";
      if (bioEl) bioEl.value = "";
      saveCharacterBg("", "");
      showToast("背景设定已清空", 1400);
      forceBgToggleEnabled();
    });
  }

  restoreBgInputs();
}

/** 把已保存的背景文本回填到输入框, 并挂上自动保存 */
function restoreBgInputs() {
  const stored = loadCharacterBg();
  const targetEl = document.getElementById("bgTarget");
  const bioEl = document.getElementById("bgBio");

  if (targetEl && !targetEl.value) targetEl.value = stored.target;
  if (bioEl && !bioEl.value) bioEl.value = stored.bio;

  if (targetEl && !targetEl.dataset.bgBound) {
    targetEl.dataset.bgBound = "1";
    targetEl.addEventListener("input", function () {
      const t = document.getElementById("bgTarget");
      const b = document.getElementById("bgBio");
      saveCharacterBg(t ? t.value : "", b ? b.value : "");
    });
  }
  if (bioEl && !bioEl.dataset.bgBound) {
    bioEl.dataset.bgBound = "1";
    bioEl.addEventListener("input", function () {
      const t = document.getElementById("bgTarget");
      const b = document.getElementById("bgBio");
      saveCharacterBg(t ? t.value : "", b ? b.value : "");
    });
  }
}

/** 展开 / 收起背景面板: 任何模式都允许 (Bug6 / Bug10) */
function toggleBgPanel(open) {
  const panel = document.getElementById("bgPanel");
  const btn = document.getElementById("bgToggleBtn");
  const hint = document.getElementById("bgHint");

  bgPanelOpen = typeof open === "boolean" ? open : !bgPanelOpen;

  if (panel) panel.hidden = !bgPanelOpen;
  if (btn) {
    btn.disabled = false;
    btn.setAttribute("aria-expanded", bgPanelOpen ? "true" : "false");
    btn.textContent = bgPanelOpen ? "收起：宣泄对象背景设置" : "展开：宣泄对象背景设置";
  }
  if (hint) {
    hint.textContent = bgPanelOpen
      ? (isVentMode() ? "当前是受骂模式, 保存后会进入对话" : "当前是反驳助手, 背景只在受骂模式生效")
      : "两种模式都能编辑, 只有受骂模式会用到";
  }
  if (bgPanelOpen) restoreBgInputs();
}

/** 受骂进度显示: 只属于受骂模式 */
function renderVentMeter() {
  const bar = document.getElementById("ventMeterBar");
  const label = document.getElementById("ventMeterLabel");
  const wrap = document.getElementById("ventMeterWrap");
  const box = document.getElementById("ventMeterBox");

  if (box) box.hidden = !isVentMode();
  if (!bar && !label) return;

  const rounds = Math.min(ventState.rounds, VENT_PARAMS.minRounds);
  const pct = Math.round(rounds / VENT_PARAMS.minRounds * 100);
  const phase = ventPhaseOf(Math.max(rounds, 1));

  if (bar) bar.style.width = Math.max(2, pct) + "%";
  if (label) {
    label.textContent = ventState.gameOver
      ? "本局已结束"
      : "第 " + ventState.rounds + " / " + VENT_PARAMS.minRounds + " 轮 · " + phase.title;
  }
  if (wrap) {
    wrap.setAttribute("data-stage", ventState.gameOver ? "end" : rounds >= 7 ? "shake" : "listen");
  }
}

/* ==================== 二十四. 模式切换 (Bug2 / Bug7 / Bug9 / Bug10) ==================== */

function setMode(next, options) {
  const opts = options || {};
  const mode = next === "vent" ? "vent" : "debate";
  const prev = getMode();

  setSetting("mode", mode);
  document.body.classList.toggle("mode-vent", mode === "vent");
  document.body.classList.toggle("mode-debate", mode !== "vent");

  if (prev !== mode) {
    /* 作废在途请求: 防止上一模式的回复写进另一个模式的存储 */
    sessionEpoch += 1;
    removeThinkingMessage();
    setLoading(false);

    /* Bug2: 清空回合计数 / 压力分值 / gameOver */
    resetVentState();
  }

  if (userInput) {
    userInput.disabled = false;
    userInput.placeholder = mode === "vent" ? "继续说, 我听着" : "说出你的想法, 我来反驳";
  }
  if (sendButton) sendButton.disabled = false;

  /* Bug6 / Bug10: 背景按钮永远可点 */
  forceBgToggleEnabled();

  const hint = document.getElementById("bgHint");
  if (hint) {
    hint.textContent = bgPanelOpen
      ? (mode === "vent" ? "当前是受骂模式, 保存后会进入对话" : "当前是反驳助手, 背景只在受骂模式生效")
      : "两种模式都能编辑, 只有受骂模式会用到";
  }

  const tabs = document.querySelectorAll("#modeSwitch [data-mode]");
  for (let i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle("active", tabs[i].getAttribute("data-mode") === mode);
  }

  if (!opts.keepHistory) {
    chatHistory = loadSession();
    renderHistoryMessages();
    updateStats();
  }

  /* 反驳强度界面只在辩论模式刷新 (Bug7) */
  if (mode === "debate") initStrength();

  refreshAiAvatars();
  renderVentMeter();

  if (!opts.silent && prev !== mode) {
    showToast(mode === "vent" ? "已切换到受骂模式" : "已切换到反驳助手", 1500);
  }
}

/* ==================== 二十五. 渲染历史 / 清空 ==================== */

function renderWelcome() {
  if (isVentMode()) {
    appendMessage(
      "assistant",
      "我在这里听着.<br>你想说什么就说什么, 我不反驳, 也不评判.",
      { emoji: true }
    );
    return;
  }
  appendMessage(
    "assistant",
    "说说你的计划吧, 我先站到对面去, 看看哪儿经不起推敲.",
    { emoji: true }
  );
}

function renderHistoryMessages() {
  if (!chatArea) return;
  chatArea.innerHTML = "";

  if (!Array.isArray(chatHistory) || chatHistory.length <= 1) {
    renderWelcome();
    return;
  }

  for (let i = 0; i < chatHistory.length; i++) {
    const msg = chatHistory[i];
    if (!msg || msg.role === "system") continue;
    if (msg.role === "user") {
      appendMessage("user", escapeHtml(msg.content), { text: msg.content });
    } else if (msg.role === "assistant") {
      appendMessage("assistant", formatReply(msg.content), { text: msg.content, emoji: true });
    }
  }
  scrollToBottom();
}

async function handleClear() {
  if (isClearing) return;
  isClearing = true;

  sessionEpoch += 1;
  removeThinkingMessage();
  setLoading(false);

  const messages = Array.prototype.slice.call(
    chatArea.querySelectorAll(".message, .ending-card, .vote-card")
  );
  chatArea.classList.add("clearing");
  messages.forEach(function (el, i) {
    el.style.animationDelay = Math.min(i * 25, 200) + "ms";
  });

  await wait(messages.length ? 300 + Math.min(messages.length * 25, 200) : 0);

  chatArea.classList.remove("clearing");
  chatArea.innerHTML = "";
  messages.forEach(function (el) { el.style.animationDelay = ""; });

  /* 只清空当前模式的会话, 另一模式数据完全不受影响 */
  chatHistory = [{ role: "system", content: currentSystemPrompt() }];
  saveSession(chatHistory);

  resetVentState();

  userInput.disabled = false;
  userInput.value = "";
  userInput.placeholder = isVentMode() ? "继续说, 我听着" : "说出你的想法, 我来反驳";
  if (sendButton) sendButton.disabled = false;
  autoResizeInput();

  renderWelcome();
  updateStats();

  isClearing = false;
  forceBgToggleEnabled();
  showToast("对话已清空, 可以重新开始一场", 1500);
  if (!IS_TOUCH) userInput.focus();
}

/* ==================== 二十六. 闪回 (功能保留) ==================== */

function openFlashback() {
  const msgs = chatHistory.filter(function (m) {
    return m.role === "user" || m.role === "assistant";
  }).slice(-12).reverse();

  if (!msgs.length) {
    showToast("还没有过往对话可以闪回, 先聊上两句", 1800);
    return;
  }

  let html = '<div class="hint">选一条过往片段, 插进输入框继续聊:</div>';
  msgs.forEach(function (m, i) {
    const text = String(m.content || "");
    html += '<div class="list-item"><div class="li-main">' +
      '<div class="li-sub">' + (m.role === "user" ? "我" : "对方") + " · 片段 " + (i + 1) + "</div>" +
      escapeHtml(text.slice(0, 90)) + "</div>" +
      '<button class="mini-btn" type="button" data-fb="' + i + '">插入</button></div>';
  });

  openAppModal("🕯️ 回忆闪回", html, [{ label: "关闭", primary: true, onClick: closeAppModal }]);

  const body = document.getElementById("modalBody");
  if (!body) return;
  body.addEventListener("click", function (e) {
    const btn = e.target && e.target.closest ? e.target.closest("[data-fb]") : null;
    if (!btn) return;
    const idx = Number(btn.getAttribute("data-fb"));
    const picked = msgs[idx];
    if (!picked) return;
    const snippet = String(picked.content || "").slice(0, 200);
    userInput.value = "上次说到: " + snippet + "\n这件事我还想再说说.\n" + userInput.value;
    autoResizeInput();
    closeAppModal();
    userInput.focus();
    showToast("已插入输入框, 可以直接发送", 1500);
  });
}

/* ==================== 二十七. 情绪小结 (功能保留) ==================== */

function localMoodText() {
  const rounds = chatHistory.filter(function (m) { return m.role === "user"; }).length;
  const pressure = isVentMode() ? ventState.pressure : 0;
  return [
    "情绪关键词: 憋屈, 疲惫, 想被理解",
    "你这次一共说了 " + rounds + " 句话" + (isVentMode() ? ", 累计压力 " + pressure + " 分" : "") + ".",
    "情绪强度: " + (pressure >= VENT_PARAMS.pressureThreshold ? "偏高" : rounds >= 5 ? "中等" : "偏低") + ".",
    "今晚可以做的一个小动作: 把最想说的那三句话写进备忘录, 明天再决定要不要发出去.",
    "给自己一句话: 你的感受不需要被批准.",
  ].join("\n");
}

function showModalText(title, text, tip) {
  const safe = escapeHtml(text).replace(/\n/g, "<br>");
  const html =
    '<div class="summary-box">' + safe + "</div>" +
    (tip ? '<p class="hint">' + escapeHtml(tip) + "</p>" : "");
  openAppModal(title, html, [
    { label: "复制小结", onClick: function () { copyText(text); } },
    { label: "关闭", primary: true, onClick: closeAppModal },
  ]);
}

async function runAiText(title, promptText) {
  const history = chatHistory.filter(function (m) {
    return m.role === "user" || m.role === "assistant";
  });

  if (!history.length) {
    showToast("还没有对话内容, 先聊上两句再生成", 1800);
    return;
  }
  if (!navigator.onLine) {
    showToast("当前离线, 生成小结需要联网", 1800);
    return;
  }
  if (!getApiKey()) {
    showModalText(title, localMoodText(), "未填写 API Key, 以上为本地估算的小结");
    return;
  }

  openAppModal(title, '<div class="hint">正在生成, 请稍候...</div>', [
    { label: "关闭", primary: true, onClick: closeAppModal },
  ]);

  const transcript = history.map(function (m) {
    return (m.role === "user" ? "我: " : "对方: ") + m.content;
  }).join("\n");

  try {
    const reply = await callDeepSeek([
      { role: "system", content: "你是一名克制, 精准的中文写作助手." },
      { role: "user", content: promptText + "\n\n--- 对话记录 ---\n" + transcript },
    ], 0.6);

    const safe = escapeHtml(reply).replace(/\n/g, "<br>");
    setAppModalBody('<div class="summary-box">' + safe + "</div>");
    setAppModalActions([
      { label: "复制小结", onClick: function () { copyText(reply); } },
      { label: "关闭", primary: true, onClick: closeAppModal },
    ]);
  } catch (err) {
    setAppModalBody('<div class="error-box">生成失败: ' + escapeHtml(err.message) + "</div>");
  }
}

function openMoodSummary() {
  runAiText(
    "🫧 情绪小结",
    "请阅读下面的对话记录, 生成一张情绪复盘卡片, 中文, 语气克制不煽情.\n" +
    "分成四段, 每段一行标题加一句内容: 情绪关键词, 我真正在意的事, 情绪强度与依据, 今晚能做的一个小动作."
  );
}

/* ==================== 二十八. 涂鸦 (功能保留) ==================== */

function loadDrawings() {
  if (window.DDHStore && DDHStore.Drawings) {
    try { return DDHStore.Drawings.list() || []; } catch (e) {}
  }
  let arr = [];
  try { arr = JSON.parse(safeGet("ddh:drawings") || "[]"); } catch (e) { arr = []; }
  return Array.isArray(arr) ? arr : [];
}

function saveDrawings(arr) {
  if (window.DDHStore && DDHStore.Drawings) {
    try {
      const old = DDHStore.Drawings.list();
      const added = arr[0];
      if (added && (!old.length || old[0].id !== added.id)) {
        DDHStore.Drawings.add(added.data);
        return true;
      }
      if (!arr.length) {
        DDHStore.Drawings.clear();
        return true;
      }
    } catch (e) {}
  }
  return safeSet("ddh:drawings", JSON.stringify(Array.isArray(arr) ? arr.slice(0, 6) : []));
}

function openDrawPad() {
  const list = loadDrawings();

  let html = '<div class="hint">随手画下此刻的心情, 只保存在本机.</div>';
  html += '<div class="draw-wrap"><canvas id="drawCanvas" class="draw-canvas" width="640" height="400"></canvas></div>';
  html += '<div class="draw-tools">';
  ["#2563eb", "#ef4444", "#22c55e", "#f59e0b", "#1f2937"].forEach(function (c) {
    html += '<button class="dot" type="button" data-color="' + c + '" style="background:' + c + '"></button>';
  });
  html += '<button class="mini-btn" type="button" data-draw="clear">清空画布</button>';
  html += '<button class="mini-btn primary" type="button" data-draw="save">保存涂鸦</button>';
  html += "</div>";

  if (list.length) {
    html += '<div class="draw-list">';
    list.forEach(function (d, i) {
      html += '<div class="draw-item"><img src="' + d.data + '" alt="涂鸦" />' +
        '<div class="di-meta">第 ' + (i + 1) + " 张 · " + fmtTime(d.ts) + "</div>" +
        '<button class="mini-btn" type="button" data-draw-del="' + i + '">删除</button></div>';
    });
    html += "</div>";
  }

  openAppModal("🖍️ 情绪涂鸦板", html, [{ label: "关闭", primary: true, onClick: closeAppModal }]);
  setupDrawCanvas();
}

function setupDrawCanvas() {
  const cv = document.getElementById("drawCanvas");
  if (!cv) return;

  const ctx = cv.getContext("2d");
  let drawing = false;
  let color = "#2563eb";

  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;

  function pos(e) {
    const rect = cv.getBoundingClientRect();
    const p = e.touches && e.touches[0] ? e.touches[0] : e;
    return {
      x: (p.clientX - rect.left) * (cv.width / rect.width),
      y: (p.clientY - rect.top) * (cv.height / rect.height),
    };
  }

  function start(e) {
    e.preventDefault();
    drawing = true;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }

  function move(e) {
    if (!drawing) return;
    e.preventDefault();
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  function end() { drawing = false; }

  cv.addEventListener("touchstart", start, { passive: false });
  cv.addEventListener("touchmove", move, { passive: false });
  cv.addEventListener("touchend", end);
  cv.addEventListener("mousedown", start);
  cv.addEventListener("mousemove", move);
  cv.addEventListener("mouseup", end);
  cv.addEventListener("mouseleave", end);

  const body = document.getElementById("modalBody");
  if (!body) return;

  body.addEventListener("click", function (e) {
    const t = e.target;
    if (!t || !t.closest) return;

    const dot = t.closest("[data-color]");
    if (dot) {
      color = dot.getAttribute("data-color");
      ctx.strokeStyle = color;
      return;
    }

    const act = t.closest("[data-draw]");
    if (act) {
      if (act.getAttribute("data-draw") === "clear") {
        ctx.clearRect(0, 0, cv.width, cv.height);
      } else {
        try {
          const dataUrl = cv.toDataURL("image/jpeg", 0.7);
          const arr = loadDrawings();
          arr.unshift({ id: String(Date.now()), data: dataUrl, ts: Date.now() });
          const ok = saveDrawings(arr.slice(0, 6));
          showToast(ok ? "涂鸦已保存到本机" : "保存失败, 可能是存储空间不足", 1600);
          if (ok) openDrawPad();
        } catch (err) {
          showToast("保存失败, 请再试一次", 1600);
        }
      }
      return;
    }

    const del = t.closest("[data-draw-del]");
    if (del) {
      const idx = Number(del.getAttribute("data-draw-del"));
      const arr = loadDrawings();
      arr.splice(idx, 1);
      saveDrawings(arr);
      openDrawPad();
    }
  });
}

/* ==================== 二十九. 情绪标签 ==================== */

function addMoodTag(tag) {
  if (!tag) return;
  if (window.DDHStore && DDHStore.Tags) {
    try { DDHStore.Tags.add(tag); return; } catch (e) {}
  }
  let data = { counts: {}, records: [] };
  try {
    const raw = JSON.parse(safeGet("ddh:tags") || "null");
    if (raw && raw.counts && typeof raw.counts === "object") data = raw;
  } catch (e) {}
  data.counts[tag] = (Number(data.counts[tag]) || 0) + 1;
  if (!Array.isArray(data.records)) data.records = [];
  data.records.unshift({ tag: tag, ts: Date.now() });
  if (data.records.length > 300) data.records.length = 300;
  safeSet("ddh:tags", JSON.stringify(data));
}

function openMoodTagSheet() {
  const tags = (window.DDHPersonas && DDHPersonas.MOOD_TAGS) || [
    { tag: "委屈" }, { tag: "恼火" }, { tag: "疲惫" }, { tag: "无奈" }, { tag: "失望" },
  ];

  let html = '<div class="hint">这场对话结束了, 此刻最接近你的情绪是?</div><div class="tag-picker">';
  tags.forEach(function (m) {
    html += '<button class="tag-opt" type="button" data-tag="' + escapeHtml(m.tag) + '">' + escapeHtml(m.tag) + "</button>";
  });
  html += "</div>";

  openAppModal("🏷️ 记录此刻的情绪", html, [{ label: "跳过", primary: true, onClick: closeAppModal }]);

  const body = document.getElementById("modalBody");
  if (!body) return;
  body.addEventListener("click", function (e) {
    const btn = e.target && e.target.closest ? e.target.closest("[data-tag]") : null;
    if (!btn) return;
    const tag = btn.getAttribute("data-tag");
    addMoodTag(tag);
    closeAppModal();
    showToast("已记录: " + tag, 1400);
  });
}

/* ==================== 三十. 辩题 / 回看 / 摘要 / 计分 ==================== */

function openTopicPicker() {
  const topic = CAMPUS_TOPICS[Math.floor(Math.random() * CAMPUS_TOPICS.length)];
  openAppModal("🎲 校园辩题", '<div class="topic-box">' + escapeHtml(topic) + "</div>", [
    { label: "换一个", onClick: openTopicPicker },
    {
      label: "用它开辩",
      onClick: function () {
        userInput.value = "我想聊聊这个辩题: " + topic + "\n我的立场是: ";
        autoResizeInput();
        closeAppModal();
        userInput.focus();
      },
    },
    { label: "关闭", primary: true, onClick: closeAppModal },
  ]);
}

function collectRounds() {
  const out = [];
  let cur = null;
  chatHistory.forEach(function (m) {
    if (m.role === "user") {
      if (cur && cur.ai) out.push(cur);
      cur = { user: m.content, ai: "" };
    } else if (m.role === "assistant" && cur) {
      cur.ai = cur.ai ? cur.ai + "\n" + m.content : m.content;
    }
  });
  if (cur && cur.ai) out.push(cur);
  return out;
}

function openRecall() {
  const rounds = collectRounds();
  if (!rounds.length) {
    showToast("还没有可回看的回合", 1600);
    return;
  }

  const last = rounds[rounds.length - 1];
  const html =
    '<div class="recall-head">共 ' + rounds.length + " 轮, 下面是最近一轮</div>" +
    '<div class="recall-block"><div class="recall-role">我</div><div class="recall-text">' +
    escapeHtml(last.user) + "</div></div>" +
    '<div class="recall-block"><div class="recall-role">对方</div><div class="recall-text">' +
    escapeHtml(last.ai) + "</div></div>";

  openAppModal("⏱ 时光回看", html, [{ label: "关闭", primary: true, onClick: closeAppModal }]);
}

function openDebateSummary() {
  runAiText(
    "📝 整场摘要",
    "请阅读下面的对话记录, 用中文写一段 300 字以内的综述: 我提出过哪些想法, 对方最有力的反驳是什么, 我还没回应的漏洞, 以及三条可执行的建议."
  );
}

function toggleScoreboard() {
  const board = document.getElementById("scoreboard");
  if (!board) return;
  board.hidden = !board.hidden;
  renderScoreValues();
}

function renderScoreValues() {
  const mine = document.getElementById("scoreMine");
  const rival = document.getElementById("scoreRival");
  let s = { mine: 0, rival: 0 };
  if (window.DDHStore && DDHStore.Score) {
    try { s = DDHStore.Score.get(); } catch (e) {}
  } else {
    try {
      const raw = JSON.parse(safeGet("ddh:score") || "null");
      if (raw && typeof raw === "object") s = { mine: Number(raw.mine) || 0, rival: Number(raw.rival) || 0 };
    } catch (e) {}
  }
  if (mine) mine.textContent = String(s.mine);
  if (rival) rival.textContent = String(s.rival);
}

function changeScore(side, delta) {
  if (window.DDHStore && DDHStore.Score) {
    try { DDHStore.Score.change(side, delta); renderScoreValues(); return; } catch (e) {}
  }
  let s = { mine: 0, rival: 0 };
  try {
    const raw = JSON.parse(safeGet("ddh:score") || "null");
    if (raw && typeof raw === "object") s = { mine: Number(raw.mine) || 0, rival: Number(raw.rival) || 0 };
  } catch (e) {}
  const k = side === "rival" ? "rival" : "mine";
  s[k] = s[k] + (Number(delta) || 0);
  safeSet("ddh:score", JSON.stringify(s));
  renderScoreValues();
}

/* ==================== 三十一. 移动端适配 ==================== */

function syncViewportHeight() {
  const vv = window.visualViewport;
  const height = vv && vv.height ? Math.round(vv.height) : window.innerHeight;
  document.documentElement.style.setProperty("--app-vh", height + "px");
}

function initViewport() {
  syncViewportHeight();

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncViewportHeight);
    window.visualViewport.addEventListener("scroll", function () {
      syncViewportHeight();
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    });
  }
  window.addEventListener("resize", syncViewportHeight);
  window.addEventListener("orientationchange", function () {
    setTimeout(syncViewportHeight, 200);
  });

  if (userInput) {
    userInput.addEventListener("focus", function () {
      document.body.classList.add("keyboard-open");
      setTimeout(function () { scrollToBottom(true); }, 300);
    });
    userInput.addEventListener("blur", function () {
      document.body.classList.remove("keyboard-open");
    });
  }
}

function autoResizeInput() {
  if (!userInput) return;
  const MAX = 132;
  userInput.style.height = "auto";
  const next = Math.min(userInput.scrollHeight + 2, MAX);
  userInput.style.height = next + "px";
  userInput.style.overflowY = userInput.scrollHeight + 2 > MAX ? "auto" : "hidden";
}

/* ==================== 三十二. 设置面板 ==================== */

function openSettingsSheet() {
  const sheet = document.getElementById("settingsSheet");
  if (!sheet) return;
  renderFallbackSettings(false);
  sheet.hidden = false;
  sheet.setAttribute("aria-hidden", "false");
  document.body.classList.add("sheet-open");
}

function closeSettingsSheet() {
  const sheet = document.getElementById("settingsSheet");
  if (!sheet) return;
  sheet.hidden = true;
  sheet.setAttribute("aria-hidden", "true");
  document.body.classList.remove("sheet-open");
}

/** 设置面板点击委托: 只绑一次, 避免重绘导致监听器叠加 */
function onSettingsBodyClick(e) {
  const t = e.target;
  if (!t || !t.closest) return;

  const modeBtn = t.closest("[data-fb-mode]");
  if (modeBtn) {
    setMode(modeBtn.getAttribute("data-fb-mode"));
    renderFallbackSettings(true);
    return;
  }

  const toolBtn = t.closest("[data-fb-tool]");
  if (toolBtn) {
    const tool = toolBtn.getAttribute("data-fb-tool");
    closeSettingsSheet();
    if (tool === "flashback") openFlashback();
    else if (tool === "mood") openMoodSummary();
    else if (tool === "draw") openDrawPad();
    else if (tool === "tag") openMoodTagSheet();
  }
}

function renderFallbackSettings(force) {
  const body = document.getElementById("settingsBody");
  if (!body) return;
  if (!force && body.children.length) return;

  const key = getApiKey();
  const mode = getMode();

  body.innerHTML =
    '<section class="group">' +
    '  <h3 class="group-title">🔑 DeepSeek API Key</h3>' +
    '  <div class="row">' +
    '    <input id="fbApiKey" class="field-input" type="text" autocomplete="off" spellcheck="false" placeholder="sk-..." value="' + escapeHtml(key) + '" />' +
    '  </div>' +
    '  <button id="fbSaveKey" class="mini-btn primary block" type="button">保存密钥</button>' +
    '  <p class="hint">密钥只写入本机 localStorage, 源码中不保存任何密钥.</p>' +
    '</section>' +
    '<section class="group">' +
    '  <h3 class="group-title">🎭 对话模式</h3>' +
    '  <div class="mode-tabs">' +
    '    <button class="mode-tab' + (mode === "vent" ? "" : " active") + '" type="button" data-fb-mode="debate">反驳助手</button>' +
    '    <button class="mode-tab' + (mode === "vent" ? " active" : "") + '" type="button" data-fb-mode="vent">受骂模式</button>' +
    '  </div>' +
    '  <p class="hint">两套对话分开存储: debate_chat 与 vent_chat.</p>' +
    '</section>' +
    '<section class="group">' +
    '  <h3 class="group-title">🖼️ 对方头像</h3>' +
    '  <button id="fbAvatar" class="mini-btn block" type="button">切换对方头像</button>' +
    '  <button id="fbResetAvatar" class="mini-btn block" type="button">恢复默认文字头像</button>' +
    '</section>' +
    '<section class="group">' +
    '  <h3 class="group-title">🧰 附加功能</h3>' +
    '  <div class="btn-grid">' +
    '    <button class="mini-btn" type="button" data-fb-tool="flashback">回忆闪回</button>' +
    '    <button class="mini-btn" type="button" data-fb-tool="mood">情绪小结</button>' +
    '    <button class="mini-btn" type="button" data-fb-tool="draw">情绪涂鸦</button>' +
    '    <button class="mini-btn" type="button" data-fb-tool="tag">情绪标签</button>' +
    '  </div>' +
    '</section>' +
    '<p class="version">决策辩论助手 · 简化设置面板</p>';

  const saveBtn = document.getElementById("fbSaveKey");
  if (saveBtn) {
    saveBtn.addEventListener("click", function () {
      const input = document.getElementById("fbApiKey");
      if (!input) return;
      setSetting("apiKey", String(input.value || "").trim());
      showToast("密钥已保存在本机", 1600);
    });
  }

  const avBtn = document.getElementById("fbAvatar");
  if (avBtn) avBtn.addEventListener("click", function () { closeSettingsSheet(); openAvatarPicker(); });

  const avResetBtn = document.getElementById("fbResetAvatar");
  if (avResetBtn) {
    avResetBtn.addEventListener("click", function () {
      setStoredAvatar("");
      refreshAiAvatars();
      showToast("已恢复默认文字头像", 1400);
    });
  }

  if (!body.dataset.bound) {
    body.dataset.bound = "1";
    body.addEventListener("click", onSettingsBodyClick);
  }
}

/* ==================== 三十三. DDHPanel 垫片 ==================== */

function installPanelShim() {
  if (window.DDHPanel && typeof DDHPanel.openModal === "function") {
    console.log("[DDH] 检测到 panel.js, 不需要垫片");
    return;
  }

  console.warn("[DDH] panel.js 未加载, 已启用内置垫片");

  window.DDHPanel = {
    __shim: true,
    init: function () {
      const gear = document.getElementById("settingsToggle");
      if (gear && !gear.dataset.shimGear) {
        gear.dataset.shimGear = "1";
        gear.addEventListener("click", function () {
          const sheet = document.getElementById("settingsSheet");
          if (sheet && !sheet.hidden) return;
          openSettingsSheet();
        });
      }
      const closeBtn = document.getElementById("settingsClose");
      if (closeBtn && !closeBtn.dataset.shimClose) {
        closeBtn.dataset.shimClose = "1";
        closeBtn.addEventListener("click", closeSettingsSheet);
      }
      const sheet = document.getElementById("settingsSheet");
      if (sheet && !sheet.dataset.shimMask) {
        sheet.dataset.shimMask = "1";
        sheet.addEventListener("click", function (e) {
          const t = e.target;
          if (t && t.hasAttribute && t.hasAttribute("data-close-sheet")) closeSettingsSheet();
        });
      }
      renderFallbackSettings(true);
    },
    render: function () { renderFallbackSettings(true); },
    refresh: function () {
      const sheet = document.getElementById("settingsSheet");
      if (sheet && !sheet.hidden) renderFallbackSettings(true);
    },
    openModal: openAppModal,
    closeModal: closeAppModal,
    setModalBody: setAppModalBody,
    setModalActions: setAppModalActions,
    modalBodyEl: function () { return document.getElementById("modalBody"); },
    openTagSheet: openMoodTagSheet,
    openTagWall: openMoodTagSheet,
    openDrawPad: openDrawPad,
    openFavorites: function () { showToast("收藏在每条消息气泡下方的小星星里", 1800); },
    openBadges: function () { showToast("成就徽章需要完整设置面板", 1800); },
  };
}

/* ==================== 三十四. 启动工具 ==================== */

function onReady(fn) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fn, { once: true });
  } else {
    setTimeout(fn, 0);
  }
}

function safeRun(label, fn, retry) {
  try {
    fn();
    return true;
  } catch (err) {
    console.error("[DDH] " + label + " 初始化失败", err);
    if (retry) {
      setTimeout(function () {
        try { fn(); } catch (err2) { console.error("[DDH] " + label + " 重试仍失败", err2); }
      }, 300);
    }
    return false;
  }
}

function applyStoredFontSize() {
  const fs = Number(getSetting("fontSize", 1)) || 1;
  document.documentElement.style.setProperty("--font-scale", String(fs));
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol === "file:") return;

  window.addEventListener("load", function () {
    navigator.serviceWorker.register("./service-worker.js")
      .then(function (reg) { if (reg && reg.update) reg.update(); })
      .catch(function (err) { console.warn("[DDH] SW 注册失败, 不影响使用", err); });
  });
}

function bindClickOnce(id, handler) {
  const el = document.getElementById(id);
  if (!el) return false;
  if (el.dataset.ddhBound === "1") return true;
  el.dataset.ddhBound = "1";
  el.addEventListener("click", handler);
  return true;
}

function installExtraButtons() {
  bindClickOnce("btnAvatar", openAvatarPicker);

  if (chatArea && !chatArea.dataset.avatarClickBound) {
    chatArea.dataset.avatarClickBound = "1";
    chatArea.addEventListener("click", function (e) {
      const t = e.target;
      const avatar = t && t.closest ? t.closest(".avatar") : null;
      if (!avatar) return;
      const msg = avatar.closest(".message");
      if (!msg || msg.classList.contains("user") || msg.classList.contains("error")) return;
      openAvatarPicker();
    });
  }

  if (engineReady) return;

  bindClickOnce("btnFlashback", openFlashback);
  bindClickOnce("btnMood", openMoodSummary);
  bindClickOnce("btnDraw", openDrawPad);
  bindClickOnce("btnTopics", openTopicPicker);
  bindClickOnce("btnRecall", openRecall);
  bindClickOnce("btnSummary", openDebateSummary);
  bindClickOnce("btnScore", toggleScoreboard);
  console.log("[DDH] engine.js 未接管, 附加按钮由 main.js 绑定");
}

function installGearFallback() {
  const gear = document.getElementById("settingsToggle");
  const sheet = document.getElementById("settingsSheet");
  if (!gear || !sheet) return;

  gear.addEventListener("click", function () {
    if (!sheet.hidden) return;
    try {
      if (window.DDHPanel && typeof DDHPanel.init === "function") {
        DDHPanel.init();
        if (typeof DDHPanel.render === "function") DDHPanel.render();
      }
    } catch (err) {
      console.error("[DDH] 设置面板补救失败", err);
    }
    if (!sheet.hidden) return;
    openSettingsSheet();
  });
}

/** 接管 engine 的模式切换, 保证一定走 setMode (Bug2) */
function patchEngineModeSwitch() {
  if (!window.DDHEngine) return;
  window.DDHEngine.applyMode = function (next) {
    setMode(next);
  };
}

/* ==================== 三十五. 对外桥接接口 ==================== */

window.DDH = {
  version: "3.4.0",
  config: {
    API_URL: API_URL,
    MODEL_NAME: MODEL_NAME,
    REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS,
    DEMO_MODE: false,
    IS_TOUCH: IS_TOUCH,
    AI_EMOJIS: AI_EMOJIS,
  },
  els: {
    chatArea: chatArea,
    userInput: userInput,
    sendButton: sendButton,
    clearButton: clearButton,
    themeToggle: themeToggle,
    themeIcon: themeIcon,
    roundCountEl: roundCountEl,
    msgCountEl: msgCountEl,
    strengthValueEl: strengthValueEl,
    strengthSlider: strengthSlider,
    strengthTip: strengthTip,
    strengthLabels: strengthLabels,
  },
  ui: {
    appendMessage: appendMessage,
    appendThinkingMessage: appendThinkingMessage,
    removeThinkingMessage: removeThinkingMessage,
    setLoading: setLoading,
    scrollToBottom: scrollToBottom,
    showToast: showToast,
    escapeHtml: escapeHtml,
    formatReply: formatReply,
    updateStats: updateStats,
    autoResizeInput: autoResizeInput,
    applyTheme: applyTheme,
    bump: bump,
    pickEmoji: pickEmoji,
  },
  getHistory: function () { return chatHistory; },
  setHistory: function (arr) {
    chatHistory = Array.isArray(arr) ? arr : [];
    saveSession(chatHistory);
  },
  saveSession: function () { saveSession(chatHistory); },
  reloadSession: function () {
    chatHistory = loadSession();
    renderHistoryMessages();
    updateStats();
  },
  renderHistoryMessages: renderHistoryMessages,
  getStrengthLevel: getStrengthLevel,
  setStrength: setStrength,
  getApiKey: getApiKey,
  getMode: getMode,
  setMode: setMode,
  callDeepSeek: callDeepSeek,
  isThinking: function () { return isThinking; },
  isClearing: function () { return isClearing; },
  openAvatarPicker: openAvatarPicker,
  refreshAvatars: refreshAiAvatars,
  openAppModal: openAppModal,
  closeAppModal: closeAppModal,
  toggleBgPanel: toggleBgPanel,
  forceBgToggleEnabled: forceBgToggleEnabled,
  canEndVentSession: canEndVentSession,
  ventPhaseOf: ventPhaseOf,
  getVentState: function () {
    return { rounds: ventState.rounds, pressure: ventState.pressure, gameOver: ventState.gameOver };
  },
};

/* ==================== 三十六. 基础事件绑定 ==================== */

if (sendButton) sendButton.addEventListener("click", handleSubmit);
if (clearButton) clearButton.addEventListener("click", handleClear);
if (themeToggle) themeToggle.addEventListener("click", toggleTheme);

if (userInput) {
  userInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  });

  userInput.addEventListener("input", function () {
    if (userInput.value.trim() !== "") {
      userInput.placeholder = isVentMode() ? "继续说, 我听着" : "说出你的想法, 我来反驳";
    }
    autoResizeInput();
  });
}

/* 强度滑块: 只有反驳助手模式响应 (Bug7) */
if (strengthSlider) {
  strengthSlider.addEventListener("input", function () {
    if (!isDebateMode()) return;
    setStrength(Number(strengthSlider.value));
  });
  strengthSlider.addEventListener("change", function () {
    if (!isDebateMode()) return;
    setStrength(Number(strengthSlider.value));
  });
}

(function bindScoreboard() {
  const board = document.getElementById("scoreboard");
  if (!board) return;
  board.addEventListener("click", function (e) {
    const btn = e.target && e.target.closest ? e.target.closest("[data-side]") : null;
    if (!btn) return;
    changeScore(btn.getAttribute("data-side"), Number(btn.getAttribute("data-delta")) || 0);
    showToast("计分已更新", 900);
  });
})();

window.addEventListener("resize", function () { scrollToBottom(); });

/* ==================== 三十七. 启动编排 ==================== */

function boot() {
  safeRun("主题", initTheme);
  safeRun("字号", applyStoredFontSize);
  safeRun("视口适配", initViewport);

  safeRun("受骂状态读取", function () { ventState = loadVentState(); });

  safeRun("会话载入", function () {
    chatHistory = loadSession();
    renderHistoryMessages();
    updateStats();
    autoResizeInput();
    renderScoreValues();
  });

  /* 反驳强度只在辩论模式初始化 (Bug7) */
  safeRun("反驳强度", function () {
    if (isDebateMode()) initStrength();
  });

  safeRun("模式与背景面板挂载", mountVentFeatures);

  safeRun("DDHPanel 垫片", installPanelShim);
  safeRun("引擎模式切换接管", patchEngineModeSwitch);

  safeRun("设置面板", function () {
    if (window.DDHPanel && typeof DDHPanel.init === "function") DDHPanel.init();
  }, true);

  safeRun("对话引擎", function () {
    if (window.DDHEngine && typeof DDHEngine.init === "function") {
      DDHEngine.init();
      engineReady = true;
    }
  }, true);

  safeRun("模式同步", function () {
    setMode(getMode(), { silent: true });
  });

  /* 刷新后按 vent_state 恢复锁局, 保证 UI 与数据一致 */
  safeRun("恢复受骂锁局状态", function () {
    if (isVentMode() && ventState.gameOver && ventState.rounds >= VENT_PARAMS.minRounds) {
      lockVentSession();
    }
  });

  safeRun("附加按钮绑定", installExtraButtons);
  safeRun("齿轮兜底", installGearFallback);
  safeRun("Service Worker", registerServiceWorker);

  /* Bug10: 启动即锁定按钮可点状态, 并挂上属性守卫 */
  safeRun("背景按钮守卫", function () {
    guardBgToggle();
    forceBgToggleEnabled();
  });

  console.log("[DDH] 启动完成",
    "mode=" + getMode(),
    "DDHStore=" + !!window.DDHStore,
    "DDHEngine=" + !!window.DDHEngine,
    "DDHPanel=" + (window.DDHPanel ? (DDHPanel.__shim ? "shim" : "real") : "none"));
}

onReady(boot);
