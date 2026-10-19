/* =========================================================
   决策辩论助手 / js/main.js
   ---------------------------------------------------------
   [本次修复] 四个附加按钮失效: 闪回 / 情绪小结 / 涂鸦 / 换对方头像
   原因: 它们全部依赖 js/panel.js 里的 DDHPanel.openModal, 而 panel.js
         没有成功加载, 于是 engine.js 里 if (!panel) return; 静默退出,
         换头像则直接提示 设置面板未加载.
   修法: main.js 内置一套自建弹窗系统, 并在 panel.js 缺失时安装
         DDHPanel 垫片(shim), 提供 engine.js 需要的全部接口.
   保留: 辩论对话, 提交, 清空, localStorage 聊天记录, DeepSeek 接口.
   规则: 全文件语法标点一律英文半角; 字符串内不出现引号字符;
         多行 system 提示词只用英文反引号包裹.
   ========================================================= */

/* 全局错误捕获 */
window.addEventListener("error", function (e) {
  console.error("[DDH] 运行时错误: " + e.message + " @ " + e.filename + ":" + e.lineno);
});

/* ==================== 一. 配置常量 ==================== */

const API_URL = "https://api.deepseek.com/chat/completions";
const MODEL_NAME = "deepseek-chat";
const REQUEST_TIMEOUT_MS = 60000;

/* system 提示词: 英文反引号包裹的多行模板字符串, 内部无引号, 无插值 */
const SYSTEM_PROMPT = `你是一个真人辩手, 坐在我对面, 我们正在为我的一个决定争论.
你不是助手, 不需要讨好我, 也不需要给我一份报告.
你要做的是找出我这个想法里站不住的地方, 用你自己的话说出来:
可以不同意, 可以反问我, 可以先承认我哪句有道理然后再翻盘.
说话要像人: 一段一段接着说, 可以有停顿, 有情绪, 有口语, 句子长短交错.
绝对不要分点罗列, 不许出现 第一 第二 第三, 不许用 首先 其次 最后 做排比,
不要写小标题, 不要结论式总结, 也不要说 希望对你有帮助 或者 你怎么看 这类客套话.
一次说三四段话就够了, 说完就停, 把话头留给我.`;

const STORAGE_KEY = "harness_debate_session";
const THEME_KEY = "harness_debate_theme";
const STRENGTH_KEY = "harness_debate_strength";

/* 本地回退用的键名, 在没有 store.js 时也能工作 */
const FALLBACK_KEY = {
  settings: "ddh:settings",
  avatar: "ddh:avatar",
  drawings: "ddh:drawings",
  tags: "ddh:tags",
};

const STRENGTH_LEVELS = [
  {
    name: "温和辩论",
    tip: "先接住再问一句, 立场不退",
    temperature: 0.55,
    prompt: [
      "[本轮力度: 温和辩论]",
      "先接住我话里有道理的那半句, 让我知道你真听懂了, 然后只挑一个最要紧的疑问往深里问.",
      "语气像朋友在劝我, 但立场一步都不退. 说三四段连贯的话, 中间不要断开成分点.",
    ].join("\n"),
  },
  {
    name: "普通反驳",
    tip: "直接把不同意见摆上桌",
    temperature: 0.75,
    prompt: [
      "[本轮力度: 普通反驳]",
      "直接说出你不同意我哪一点, 把那个漏洞讲透: 为什么这么想会出问题, 现实里会怎么翻车.",
      "可以举具体场景, 举一个身边人的例子, 算笔账, 但别报数据, 别编新闻.",
      "说话要连贯, 一段接一段, 不要列条目, 不要用 首先其次 这种排比.",
    ].join("\n"),
  },
  {
    name: "强力抬杠",
    tip: "火力全开, 句子短, 火气足",
    temperature: 0.95,
    prompt: [
      "[本轮力度: 强力抬杠]",
      "上来就顶: 先否掉我最核心的那个假设, 再连着追问我两三个不好回答的问题.",
      "句子可以很短, 可以带点火气和嘲讽, 可以打断式反问, 但不许骂人, 不许攻击我这个人.",
      "全程像吵架一样连着说, 绝对不要分点罗列.",
    ].join("\n"),
  },
];
const DEFAULT_STRENGTH = 1;

const AI_EMOJIS = ["🤔", "💡", "🧐", "😮", "🔍", "🧠", "😏", "✨", "🎯", "⚡",
  "🧩", "🙃", "👀", "🧨", "🪄", "🤯", "📌", "🫣", "🍿", "🛡️"];

const DEMO_MODE = (function () {
  try {
    return new URLSearchParams(location.search).get("demo") === "1";
  } catch (e) {
    return false;
  }
})();

const THEME_COLORS = { light: "#f5f6f8", dark: "#0f1115" };

/* 校园辩题(engine 缺失时的回退数据) */
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

/* ==================== 二. 设置读取兼容层 ==================== */

/** 直接读 localStorage 里的设置对象 */
function readSettingsRaw() {
  try {
    return JSON.parse(localStorage.getItem(FALLBACK_KEY.settings) || "{}") || {};
  } catch (e) {
    return {};
  }
}

/** 读一项设置: 优先 DDHStore, 没有就直接读 localStorage */
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

/** 写一项设置 */
function setSetting(key, value) {
  if (window.DDHStore && DDHStore.Settings) {
    try {
      DDHStore.Settings.set(key, value);
      return;
    } catch (e) {}
  }
  const raw = readSettingsRaw();
  raw[key] = value;
  try { localStorage.setItem(FALLBACK_KEY.settings, JSON.stringify(raw)); } catch (e) {}
}

/** 当前模式 */
function getMode() {
  if (window.DDHStore && DDHStore.Settings) {
    try { return DDHStore.Settings.get("mode") === "vent" ? "vent" : "debate"; } catch (e) {}
  }
  const raw = readSettingsRaw();
  if (raw.mode === "vent") return "vent";
  return document.body.classList.contains("mode-vent") ? "vent" : "debate";
}

/** 密钥: 源码里不写死, 只从本机设置读 */
function getApiKey() {
  return String(getSetting("apiKey", "") || "").trim();
}

/* ==================== 三. 语气守卫 ==================== */

const DEBATE_VOICE_GUARD = [
  "[说话方式: 优先级高于以上所有要求]",
  "1. 你是坐在我对面的辩手, 不是客服也不是顾问. 用连续的话说, 一段接一段, 每段是完整的句子流.",
  "2. 绝对禁止分点: 不许出现 第一 第二 第三, 不许写 1. 2. 3. 或圈号, 也不许用 首先 其次 最后 做清单式排比.",
  "3. 不要小标题, 不要加粗标题式罗列, 不要结尾总结段.",
  "4. 禁用这些话术: 让我们来分析一下, 以下是几点建议, 综上所述, 总的来说, 希望对你有帮助.",
  "5. 不要复述我的整段原话, 顶多引一两个词; 别先总结我的观点, 直接接着我的话反驳.",
  "6. 可以有情绪: 可以说 这话我不太同意, 你自己想想, 可以反问, 可以短句打断, 但不许骂人.",
  "7. 结尾停在你真正想说的那个点上, 不要为了礼貌补客套.",
  "8. 长度控制在三四段, 250 字以内.",
].join("\n");

const VENT_VOICE_GUARD = [
  "[说话方式: 优先级高于以上所有要求]",
  "1. 不要分点罗列, 用一段一段的口语说话.",
  "2. 不反驳, 不讲道理, 不给建议清单, 先接住对方的情绪.",
  "3. 你比一般人更容易被说动: 每听两句就多沉默一点, 别一直嘴硬.",
  "4. 结尾不要客套, 说完就停.",
  "5. 控制在两到四段, 150 字以内.",
].join("\n");

function pickVoiceGuard(systemText) {
  if (!systemText) return "";
  if (systemText.indexOf("反方辩手") >= 0 || systemText.indexOf("批判性思考顾问") >= 0) {
    return DEBATE_VOICE_GUARD;
  }
  if (systemText.indexOf("扮演") >= 0 && systemText.indexOf("矛盾") >= 0) {
    return VENT_VOICE_GUARD;
  }
  return "";
}

function applyVoiceGuard(messages) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const first = messages[0];
  if (!first || first.role !== "system" || typeof first.content !== "string") return messages;
  const guard = pickVoiceGuard(first.content);
  if (!guard) return messages;
  const next = messages.slice();
  next[0] = { role: "system", content: first.content + "\n\n" + guard };
  return next;
}

/* ==================== 四. 宣泄阈值调优 ==================== */
/* 前端已隐藏参数面板, 这里运行期把破防阈值改短: 2 / 3 / 5 轮 */
const VENT_THRESHOLD_TUNING = { fragile: 2, normal: 3, tough: 5 };

function tuneVentThresholds() {
  const list = window.DDHPersonas && DDHPersonas.RESILIENCE;
  if (!Array.isArray(list)) return;
  list.forEach(function (item) {
    if (!item || !item.id) return;
    const next = VENT_THRESHOLD_TUNING[item.id];
    if (typeof next === "number") item.threshold = next;
  });
}

/* ==================== 五. 本地存储兼容层 ==================== */

/** 读数组 */
function storageGetArray(key) {
  try {
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

/** 写数组 */
function storageSetArray(key, arr, limit) {
  const list = Array.isArray(arr) ? arr.slice(0, limit || 50) : [];
  try {
    localStorage.setItem(key, JSON.stringify(list));
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------- 头像 ---------- */
function getStoredAvatar() {
  if (window.DDHStore && DDHStore.Avatars) {
    try { return DDHStore.Avatars.image() || ""; } catch (e) {}
  }
  try { return localStorage.getItem(FALLBACK_KEY.avatar) || ""; } catch (e) { return ""; }
}

function setStoredAvatar(url) {
  if (window.DDHStore && DDHStore.Avatars) {
    try {
      if (url) DDHStore.Avatars.set(url);
      else DDHStore.Avatars.reset();
      return;
    } catch (e) {}
  }
  try {
    if (url) localStorage.setItem(FALLBACK_KEY.avatar, url);
    else localStorage.removeItem(FALLBACK_KEY.avatar);
  } catch (e) {}
}

/* ---------- 涂鸦 ---------- */
function loadDrawings() {
  if (window.DDHStore && DDHStore.Drawings) {
    try { return DDHStore.Drawings.list() || []; } catch (e) {}
  }
  return storageGetArray(FALLBACK_KEY.drawings);
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
  return storageSetArray(FALLBACK_KEY.drawings, arr, 6);
}

/* ---------- 情绪标签 ---------- */
function addMoodTag(tag) {
  if (!tag) return;
  if (window.DDHStore && DDHStore.Tags) {
    try { DDHStore.Tags.add(tag); return; } catch (e) {}
  }
  let data = { counts: {}, records: [] };
  try {
    const raw = JSON.parse(localStorage.getItem(FALLBACK_KEY.tags) || "null");
    if (raw && raw.counts) data = raw;
  } catch (e) {}
  data.counts[tag] = (Number(data.counts[tag]) || 0) + 1;
  data.records.unshift({ tag: tag, ts: Date.now() });
  if (data.records.length > 300) data.records.length = 300;
  try { localStorage.setItem(FALLBACK_KEY.tags, JSON.stringify(data)); } catch (e) {}
}

/* ==================== 六. DOM 引用 ==================== */

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

/* ==================== 七. 状态 ==================== */

function currentSessionKey() {
  try {
    if (window.DDHStore && DDHStore.Session) return DDHStore.Session.key();
  } catch (e) {}
  return getMode() === "vent" ? "harness_vent_session" : STORAGE_KEY;
}

function loadSession() {
  let cache = null;
  try { cache = localStorage.getItem(currentSessionKey()); } catch (e) { cache = null; }

  if (cache) {
    try {
      const parsed = JSON.parse(cache);
      if (Array.isArray(parsed) && parsed.length) {
        if (!parsed[0] || parsed[0].role !== "system") {
          parsed.unshift({ role: "system", content: SYSTEM_PROMPT });
        }
        return parsed;
      }
    } catch (err) {
      try { localStorage.removeItem(currentSessionKey()); } catch (e) {}
    }
  }
  return [{ role: "system", content: SYSTEM_PROMPT }];
}

function saveSession(history) {
  try { localStorage.setItem(currentSessionKey(), JSON.stringify(history)); } catch (e) {}
}

let chatHistory = loadSession();
let isThinking = false;

let currentStrength = (function () {
  let saved = NaN;
  try { saved = parseInt(localStorage.getItem(STRENGTH_KEY), 10); } catch (e) {}
  return Number.isInteger(saved) && saved >= 0 && saved < STRENGTH_LEVELS.length ? saved : DEFAULT_STRENGTH;
})();

let sessionEpoch = 0;
let isClearing = false;

const IS_TOUCH = (function () {
  try { return window.matchMedia("(hover: none) and (pointer: coarse)").matches; } catch (e) { return false; }
})();

/* ==================== 八. 通用工具 ==================== */

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

/** 复制到剪贴板, 带降级方案 */
function copyText(text) {
  const str = String(text == null ? "" : text);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(str).then(function () {
      showToast("已复制到剪贴板", 1200);
    }).catch(function () {
      fallbackCopy(str);
    });
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

/* ==================== 九. 自建弹窗系统 ==================== */
/* [恢复] 关键新增: 不再依赖 panel.js, 直接操作 index.html 里的 #modalRoot.
   这些函数同时作为 DDHPanel 垫片的实现, 让 engine.js 的功能也能用. */

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

  /* 兜底补结构, 防止旧版 index.html 缺节点 */
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

/** 每次都换一个干净的 body, 顺手清掉上一次遗留的监听 */
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

/* ==================== 十. 头像 ==================== */
/* [恢复] 头像弹窗改为自建弹窗, 不再经过 DDHPanel, 彻底修掉
   提示 设置面板未加载 的 bug. */

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

/** 把头像应用到某个 .avatar 元素 */
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
    el.textContent = getMode() === "vent" ? "听" : "辩";
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
  let html = '<div class="hint">点一下就能换掉对方的头像, 也可以上传自己的图片. 换完之后所有 AI 气泡立即同步.</div>';
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

  /* 每次 openAppModal 都会换新 body, 所以这里每次都要重新挂;
     用 dataset 标记防止同一次弹窗内重复挂. */
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
      showToast("对方头像已换成 " + preset.name, 1400);
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
      showToast("已恢复默认文字头像, 辩论是辩, 宣泄是听", 1600);
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

/* ==================== 十一. 消息渲染 ==================== */

function appendMessage(role, html, options) {
  const opts = options || {};

  const wrapper = document.createElement("div");
  wrapper.className = "message " + role;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  applyAvatarTo(avatar, role); /* 改为本地函数, 不依赖 DDHStore */
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
        try {
          ok = DDHStore.Favorites.add({ role: role, text: raw, mode: getMode() });
        } catch (e) {}
      } else {
        const arr = storageGetArray("ddh:favorites");
        if (!arr.some(function (f) { return f.text === raw; })) {
          arr.unshift({ id: String(Date.now()), role: role, text: raw, mode: getMode(), ts: Date.now() });
          ok = storageSetArray("ddh:favorites", arr, 300);
        }
      }
      favBtn.textContent = ok ? "⭐" : "★";
      showToast(ok ? "已收藏这条消息" : "这条消息已经收藏过了", 1400);
      if (window.DDHEngine && ok) DDHEngine.unlockBadge("first-fav");
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

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML =
    '<span class="thinking-text">正在构思反驳观点...</span>' +
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
}

/* ==================== 十二. 主题 / 强度 / 统计 ==================== */

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

  if (persist !== false) {
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  }
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (prefersDark ? "dark" : "light"), false);
}

function toggleTheme() {
  const now = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(now, true);
  showToast(now === "dark" ? "已切换到暗黑模式" : "已切换到浅色模式", 1200);
}

function getStrengthLevel() {
  return STRENGTH_LEVELS[currentStrength] || STRENGTH_LEVELS[DEFAULT_STRENGTH];
}

function setStrength(index, options) {
  const opts = options || {};
  const raw = Number(index);
  const i = Math.max(0, Math.min(STRENGTH_LEVELS.length - 1, isNaN(raw) ? DEFAULT_STRENGTH : raw));

  currentStrength = i;
  const level = STRENGTH_LEVELS[i];

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

  if (opts.persist !== false) {
    try { localStorage.setItem(STRENGTH_KEY, String(i)); } catch (e) {}
  }
  if (opts.silent !== true && strengthValueEl) bump(strengthValueEl);
}

function initStrength() {
  setStrength(currentStrength, { persist: false, silent: true });
}

function updateStats(animate) {
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

/* ==================== 十三. 调用 DeepSeek ==================== */

async function callDeepSeek(messages, temperature) {
  if (DEMO_MODE) return demoReply(messages);

  if (!navigator.onLine) {
    throw new Error("当前网络不可用, 只能查看历史记录, 联网后才能发起新对话");
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("还没有填写 API Key, 点右上角设置按钮, 填入 DeepSeek 密钥后再试");
  }

  const sysText = messages[0] && typeof messages[0].content === "string" ? messages[0].content : "";
  const isDialog = !!pickVoiceGuard(sysText);
  const finalMessages = applyVoiceGuard(messages);

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
        messages: finalMessages,
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
    const content = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";

    if (!content) throw new Error("接口未返回有效内容");

    /* 对话场景才抹平列表标记, 摘要类任务保留结构化输出 */
    return isDialog ? stripListMarkers(content.trim()) : content.trim();
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时, 请检查网络后重试");
    if (error instanceof TypeError) throw new Error("网络请求失败, 请检查网络连接");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function stripListMarkers(text) {
  if (!text) return text;
  let out = String(text);
  out = out.replace(/^[ \t]*(\d{1,2}[.)\u3001\uFF09]|\(\d{1,2}\)|[\u2460-\u2469])[ \t]*/gm, "");
  out = out.replace(/^[ \t]*[-*\u2022\u00B7][ \t]+/gm, "");
  out = out.replace(/^[ \t]*(第[一二三四五六七八九十]{1,2}|其[一二三四五六七八九十]{1,2})[,\uFF0C\u3001\uFF1A\u3002.:][ \t]*/gm, "");
  out = out.replace(/^[ \t]*(首先|其次|再次|最后|另外|此外)[,\uFF0C\u3001][ \t]*/gm, "");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

function demoReply(messages) {
  const last = messages[messages.length - 1] || {};
  const raw = String(last.content || "你的想法").replace(/\s+/g, " ").trim();
  const short = raw.length > 18 ? raw.slice(0, 18) + "..." : raw;
  const level = getStrengthLevel();

  const templates = [
    "你说的这个我能理解, 就是: " + short + ". 说白了是不想再这么拖着, 换我也烦, 这点我跟你一样.\n\n" +
    "只是有一处我没被说服. 你现在算的是一切照计划走的情况, 可这件事里最不确定的根本不是你的执行力, 是别人配不配合你. 那块你打算怎么兜?\n\n" +
    "我不是让你别做, 我是怕你把顺利当成了默认值. 真出一次岔子, 你手里还剩下多少余地? 这才是我想问你的.",

    "关于 " + short + " 这件事, 我不太同意, 而且是关键那一层不同意.\n\n" +
    "你默认只要开始做了, 事情就会顺着走. 可现实里最常见的不是失败, 是拖, 一个环节卡住, 后面的安排全成了摆设, 你的时间成本比你预算的高出一截.\n\n" +
    "还有, 支持你这个判断的那些声音, 基本都是熟人给的. 他们的判断里带着对你的好感, 那不叫验证, 那叫打气.\n\n" +
    "你真要做, 我劝你先想清楚一件事: 什么情况下你承认这件事不该继续. 这条你现在一条都没写.",

    "停一下, " + short + " 这个想法我听不下去.\n\n" +
    "你说这个机会是因为没人做过? 我倒觉得是因为做过的人没告诉你结果.\n\n" +
    "还有, 你这套计划里根本没有对手这两个字, 你默认环境会配合你, 凭什么? 凭什么好位置没人抢, 凭什么你的时间比别人便宜?\n\n" +
    "最坏那种情况你算过没有? 三个月之后什么都没落下, 那笔账谁还? 大概率是你自己还.\n\n" +
    "你要真想干, 就把投入压到全赔了也不疼的那条线上, 多一分都别加. 先证明真有人愿意掏钱, 再谈理想.",
  ];

  const text = templates[currentStrength] || templates[DEFAULT_STRENGTH];

  return new Promise(function (resolve) {
    const delay = 900 + Math.floor(Math.random() * 600);
    setTimeout(function () {
      resolve(text + "\n\n演示模式回复, 未调用真实接口, 当前强度: " + level.name);
    }, delay);
  });
}

/* ==================== 十四. 提交 / 清空 / 历史 ==================== */

function buildRequestMessages() {
  const level = getStrengthLevel();
  const strongPrompt = SYSTEM_PROMPT + "\n\n" + level.prompt;

  return chatHistory.map(function (msg, index) {
    if (index === 0 && msg.role === "system") {
      return { role: "system", content: strongPrompt };
    }
    return msg;
  });
}

async function handleSubmit() {
  if (isThinking || isClearing) return;

  if (window.DDHEngine && typeof DDHEngine.submit === "function") {
    try {
      return await DDHEngine.submit();
    } catch (err) {
      console.error("[DDH] engine.submit 异常, 回落到内置单轮逻辑", err);
    }
  }

  const rawText = userInput.value.trim();

  if (rawText === "") {
    userInput.focus();
    userInput.placeholder = "内容不能为空, 请输入你的想法";
    return;
  }

  const epoch = sessionEpoch;

  chatHistory.push({ role: "user", content: rawText });
  saveSession(chatHistory);

  appendMessage("user", escapeHtml(rawText), { text: rawText });
  updateStats(true);

  userInput.value = "";
  userInput.placeholder = "说出你的想法, 我来当反方";
  autoResizeInput();

  setLoading(true);
  appendThinkingMessage();

  try {
    const reply = await callDeepSeek(buildRequestMessages(), getStrengthLevel().temperature);
    if (epoch !== sessionEpoch) return;

    chatHistory.push({ role: "assistant", content: reply });
    saveSession(chatHistory);

    removeThinkingMessage();
    appendMessage("assistant", formatReply(reply), { text: reply, emoji: true });
    updateStats(true);
  } catch (error) {
    if (epoch !== sessionEpoch) return;
    removeThinkingMessage();
    appendMessage("error", "错误: " + escapeHtml(error.message));
  } finally {
    if (epoch === sessionEpoch) {
      setLoading(false);
      if (!IS_TOUCH) userInput.focus();
      scrollToBottom(true);
    }
  }
}

function renderWelcome() {
  if (getMode() === "vent") {
    appendMessage(
      "assistant",
      "我在, 先不急着讲道理.<br>你想从哪儿说起都行, 说完这一段再说下一段, 我都在听.",
      { emoji: true }
    );
    return;
  }
  appendMessage(
    "assistant",
    "说吧, 你想做什么决定? 我会站到你的对面, 把这件事可能翻车的地方一个个扯出来.",
    { emoji: true }
  );
}

function renderHistoryMessages() {
  if (!chatArea) return;
  chatArea.innerHTML = "";

  if (chatHistory.length === 1) {
    renderWelcome();
    return;
  }

  for (const msg of chatHistory) {
    if (msg.role === "system") continue;
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

  const messages = Array.prototype.slice.call(chatArea.querySelectorAll(".message"));
  chatArea.classList.add("clearing");
  messages.forEach(function (el, i) {
    el.style.animationDelay = Math.min(i * 25, 200) + "ms";
  });

  await wait(messages.length ? 300 + Math.min(messages.length * 25, 200) : 0);

  chatArea.classList.remove("clearing");
  chatArea.innerHTML = "";
  messages.forEach(function (el) { el.style.animationDelay = ""; });

  chatHistory = [{ role: "system", content: SYSTEM_PROMPT }];
  saveSession(chatHistory);

  userInput.value = "";
  userInput.placeholder = "说出你的想法, 我来当反方";
  autoResizeInput();
  renderWelcome();
  updateStats();

  isClearing = false;

  if (window.DDHEngine && DDHEngine.onConversationCleared) {
    try { DDHEngine.onConversationCleared(); } catch (e) { console.error(e); }
  }

  showToast("对话已清空, 统计已重置", 1500);
  if (!IS_TOUCH) userInput.focus();
}

/* ==================== 十五. 附加功能 ==================== */
/* [恢复] 下面四个功能全部内置在 main.js, 不依赖 panel.js */

/* ---------- 1. 回忆闪回 ---------- */
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
    const prefix = "回忆闪回: 上次说到 " + snippet + " 这件事我还是想再说说.\n";
    userInput.value = prefix + userInput.value;
    autoResizeInput();
    closeAppModal();
    userInput.focus();
    showToast("已插入输入框, 可以直接发送", 1500);
  });
}

/* ---------- 2. 情绪小结 ---------- */
function localMoodText() {
  return [
    "情绪关键词: 憋屈, 疲惫, 想被理解",
    "你真正在意的: 不是这件事本身对错, 而是对方有没有认真听你把话说完.",
    "情绪强度: 中偏高, 从你的用词和句子长度能看出来.",
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
    {
      label: "复制小结",
      onClick: function () { copyText(text); },
    },
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

  if (DEMO_MODE) {
    showModalText(title, localMoodText(), "演示模式: 以上为本地示例文本");
    return;
  }
  if (!navigator.onLine) {
    showToast("当前离线, 生成小结需要联网", 1800);
    return;
  }
  if (!getApiKey()) {
    showToast("还没有填写 API Key, 请在设置面板填写后再试", 2000);
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
    "请阅读下面的对话记录, 为我生成一张情绪复盘卡片, 中文, 语气克制不煽情.\n" +
    "请分成四段, 每段一行标题加一句内容: 情绪关键词, 我真正在意的事, 情绪强度与依据, 今晚能做的一个小动作."
  );
}

/* ---------- 3. 涂鸦画布 ---------- */
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

function fmtTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  function p(n) { return n < 10 ? "0" + n : "" + n; }
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
    " " + p(d.getHours()) + ":" + p(d.getMinutes());
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
          if (ok) openDrawPad(); /* 重开一次刷新列表 */
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

/* ---------- 4. 情绪标签 ---------- */
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

/* ---------- 5. 附加: 辩题 / 回看 / 摘要 / 计分 (engine 缺失时兜底) ---------- */
function openTopicPicker() {
  const topic = CAMPUS_TOPICS[Math.floor(Math.random() * CAMPUS_TOPICS.length)];
  openAppModal("🎲 校园辩题", '<div class="topic-box">' + escapeHtml(topic) + "</div>", [
    {
      label: "换一个",
      onClick: openTopicPicker,
    },
    {
      label: "用它开辩",
      onClick: function () {
        userInput.value = "辩题: " + topic + "\n我的立场: ";
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
    "📝 辩论摘要",
    "请阅读下面的辩论记录, 用中文写一段 300 字以内的综述: 我方的核心主张, 对方最有力的质疑, 我还没回应的漏洞, 以及三条可执行的建议."
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
      const raw = JSON.parse(localStorage.getItem("ddh:score") || "null");
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
    const raw = JSON.parse(localStorage.getItem("ddh:score") || "null");
    if (raw && typeof raw === "object") s = { mine: Number(raw.mine) || 0, rival: Number(raw.rival) || 0 };
  } catch (e) {}
  const k = side === "rival" ? "rival" : "mine";
  s[k] = s[k] + (Number(delta) || 0);
  try { localStorage.setItem("ddh:score", JSON.stringify(s)); } catch (e) {}
  renderScoreValues();
}

/* ==================== 十六. 移动端适配 ==================== */

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

  userInput.addEventListener("focus", function () {
    document.body.classList.add("keyboard-open");
    setTimeout(function () { scrollToBottom(true); }, 300);
  });
  userInput.addEventListener("blur", function () {
    document.body.classList.remove("keyboard-open");
  });
}

function autoResizeInput() {
  if (!userInput) return;
  const MAX = 132;
  userInput.style.height = "auto";
  const next = Math.min(userInput.scrollHeight + 2, MAX);
  userInput.style.height = next + "px";
  userInput.style.overflowY = userInput.scrollHeight + 2 > MAX ? "auto" : "hidden";
}

/* ==================== 十七. 设置面板 (齿轮) ==================== */

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

/** 渲染设置面板内容; force 为 true 时强制重绘 */
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
    '  <p class="hint">密钥只写入本机 localStorage, 不上传到任何第三方.</p>' +
    '</section>' +
    '<section class="group">' +
    '  <h3 class="group-title">🎭 对话模式</h3>' +
    '  <div class="mode-tabs">' +
    '    <button class="mode-tab' + (mode === "vent" ? "" : " active") + '" type="button" data-fb-mode="debate">辩论模式</button>' +
    '    <button class="mode-tab' + (mode === "vent" ? " active" : "") + '" type="button" data-fb-mode="vent">情绪宣泄</button>' +
    '  </div>' +
    '  <p class="hint">两种模式各自保存一份对话记录.</p>' +
    '</section>' +
    '<section class="group">' +
    '  <h3 class="group-title">🖼️ 对方头像</h3>' +
    '  <button id="fbAvatar" class="mini-btn block" type="button">切换对方头像</button>' +
    '  <button id="fbResetAvatar" class="mini-btn block" type="button">恢复默认文字头像</button>' +
    '</section>' +
    '<section class="group">' +
    '  <h3 class="group-title">🕯️ 附加功能</h3>' +
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

  body.addEventListener("click", function (e) {
    const t = e.target;
    if (!t || !t.closest) return;

    const modeBtn = t.closest("[data-fb-mode]");
    if (modeBtn) {
      const next = modeBtn.getAttribute("data-fb-mode");
      setSetting("mode", next);
      document.body.classList.toggle("mode-vent", next === "vent");
      document.body.classList.toggle("mode-debate", next !== "vent");
      chatHistory = loadSession();
      renderHistoryMessages();
      updateStats();
      refreshAiAvatars();
      renderFallbackSettings(true);
      showToast(next === "vent" ? "已切换到情绪宣泄模式" : "已切换到辩论模式", 1400);
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
  });
}

/* ==================== 十八. DDHPanel 垫片 ==================== */
/* [恢复] 核心新增: panel.js 没加载时, 用它顶上去.
   engine.js 里的 闪回 / 情绪小结 / 涂鸦 / 辩题 / 回看 / 摘要 都通过
   DDHPanel 打开弹窗, 装上垫片后这些功能全部恢复. */

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

/* ==================== 十九. 启动工具 ==================== */

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

/** 给按钮挂一次 click, 用 dataset 防重复 */
function bindClickOnce(id, handler) {
  const el = document.getElementById(id);
  if (!el) return false;
  if (el.dataset.ddhBound === "1") return true;
  el.dataset.ddhBound = "1";
  el.addEventListener("click", handler);
  return true;
}

/* [恢复] 四个附加按钮的绑定 */
function installExtraButtons() {
  const engineOK = !!(window.DDHEngine && typeof DDHEngine.openFlashback === "function");

  /* 换头像: engine 不负责这个按钮, 永远由 main 自己处理 */
  bindClickOnce("btnAvatar", openAvatarPicker);

  /* 点任意 AI 头像也能换 */
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

  /* engine 存在时由 engine 绑定 闪回 / 情绪小结 / 涂鸦 (它已能通过垫片工作);
     engine 缺失时才由 main 兜底绑定 */
  if (!engineOK) {
    bindClickOnce("btnFlashback", openFlashback);
    bindClickOnce("btnMood", openMoodSummary);
    bindClickOnce("btnDraw", openDrawPad);
    bindClickOnce("btnTopics", openTopicPicker);
    bindClickOnce("btnRecall", openRecall);
    bindClickOnce("btnSummary", openDebateSummary);
    bindClickOnce("btnScore", toggleScoreboard);
    console.log("[DDH] engine.js 缺失, 附加按钮已由 main.js 接管");
  }
}

/* [恢复] 齿轮兜底: 即使 panel.js 和垫片都失效, 也能打开设置 */
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

/* ==================== 二十. 对外桥接接口 ==================== */
/* 这段必须留在文件前面执行? 不需要, 但必须在 boot 之前定义好.
   引擎和面板都通过 window.DDH 取能力. */

window.DDH = {
  version: "2.2.0",
  config: {
    API_URL: API_URL,
    MODEL_NAME: MODEL_NAME,
    REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS,
    DEMO_MODE: DEMO_MODE,
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
  callDeepSeek: callDeepSeek,
  isThinking: function () { return isThinking; },
  isClearing: function () { return isClearing; },
  openAvatarPicker: openAvatarPicker,
  refreshAvatars: refreshAiAvatars,
  openAppModal: openAppModal,
  closeAppModal: closeAppModal,
};

window.DDH_STRIP_LIST_MARKERS = stripListMarkers;

/* ==================== 二十一. 基础事件绑定 ==================== */

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
      userInput.placeholder = "说出你的想法, 我来当反方";
    }
    autoResizeInput();
  });
}

if (strengthSlider) {
  strengthSlider.addEventListener("input", function () {
    setStrength(Number(strengthSlider.value));
  });
  strengthSlider.addEventListener("change", function () {
    setStrength(Number(strengthSlider.value));
  });
}

/* 计分板加减分 */
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

/* ==================== 二十二. 启动编排 ==================== */

function boot() {
  safeRun("主题", initTheme);
  safeRun("强度滑块", initStrength);
  safeRun("字号", applyStoredFontSize);
  safeRun("视口适配", initViewport);
  safeRun("宣泄阈值调优", tuneVentThresholds);

  safeRun("历史渲染", function () {
    renderHistoryMessages();
    updateStats();
    autoResizeInput();
    renderScoreValues();
  });

  /* [恢复] 关键顺序: 先装垫片, 再初始化面板, 最后初始化引擎 */
  safeRun("DDHPanel 垫片", installPanelShim);

  safeRun("设置面板", function () {
    if (window.DDHPanel && typeof DDHPanel.init === "function") DDHPanel.init();
  }, true);

  safeRun("对话引擎", function () {
    if (window.DDHEngine && typeof DDHEngine.init === "function") DDHEngine.init();
  }, true);

  safeRun("附加按钮绑定", installExtraButtons);
  safeRun("齿轮兜底", installGearFallback);
  safeRun("Service Worker", registerServiceWorker);

  console.log("[DDH] 启动完成",
    "DDHStore=" + !!window.DDHStore,
    "DDHPersonas=" + !!window.DDHPersonas,
    "DDHEngine=" + !!window.DDHEngine,
    "DDHPanel=" + (window.DDHPanel ? (DDHPanel.__shim ? "shim" : "real") : "none"));
}

onReady(boot);