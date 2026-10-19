/* =========================================================
   js/store.js · 本地数据层（新增）
   职责：统一管理 localStorage。所有键名集中在此，方便分项重置。
   依赖：无。暴露 window.DDHStore
   ========================================================= */
(function (global) {
  "use strict";

  /* ---------- 一、键名表 ---------- */
  var PREFIX = "ddh:";
  var KEYS = {
    settings: PREFIX + "settings",
    favorites: PREFIX + "favorites",
    votes: PREFIX + "votes",
    score: PREFIX + "score",
    topics: PREFIX + "topics",
    badges: PREFIX + "badges",
    tags: PREFIX + "tags",
    drawings: PREFIX + "drawings",
    letters: PREFIX + "letters",
    sessionVent: PREFIX + "session_vent",
    /* ↓ 这两个键沿用旧版，保证历史对话 / 主题偏好不丢失 */
    sessionDebate: "harness_debate_session",
    theme: "harness_debate_theme",
    strength: "harness_debate_strength"
  };

  /* ---------- 二、通用读写 ---------- */
  function read(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }
  function write(key, value) {
    try {
      global.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false; // 配额满 / 隐私模式
    }
  }
  function del(key) {
    try { global.localStorage.removeItem(key); } catch (e) {}
  }
  function list(key) {
    var v = read(key, []);
    return Array.isArray(v) ? v : [];
  }
  function unshift(key, item, limit) {
    var arr = list(key);
    arr.unshift(item);
    if (limit && arr.length > limit) arr.length = limit;
    write(key, arr);
    return arr;
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function isPlain(v) { return v && typeof v === "object" && !Array.isArray(v); }

  /* 深合并（设置项里有嵌套对象 vent / avatar） */
  function mergeDeep(base, patch) {
    var out = isPlain(base) ? clone(base) : {};
    if (!isPlain(patch)) return out;
    Object.keys(patch).forEach(function (k) {
      out[k] = isPlain(patch[k]) && isPlain(out[k]) ? mergeDeep(out[k], patch[k]) : patch[k];
    });
    return out;
  }

  /* ---------- 三、设置 ---------- */
  var DEFAULT_SETTINGS = {
    apiKey: "",
    mode: "debate",        // debate | vent
    persona: "scholar",    // 辩手人设 id
    style: 1,              // 语气风格 0正式 1轻松 2犀利
    room: false,           // 多方辩论房间
    roomSpeakers: ["scholar", "roast", "humor"],
    fontSize: 1,           // 0.9 / 1 / 1.15 / 1.3
    typewriter: false,
    sound: false,
    volume: 0.6,
    avatar: "",            // AI 头像 dataURL
    vent: { target: "", bio: "", resilience: "normal" }
  };

  var Settings = {
    all: function () {
      return mergeDeep(DEFAULT_SETTINGS, read(KEYS.settings, {}) || {});
    },
    get: function (key) {
      return Settings.all()[key];
    },
    set: function (key, value) {
      var s = Settings.all();
      s[key] = value;
      write(KEYS.settings, s);
      return s;
    },
    patch: function (patchObj) {
      var s = mergeDeep(Settings.all(), patchObj);
      write(KEYS.settings, s);
      return s;
    },
    reset: function () { del(KEYS.settings); }
  };

  /* ---------- 四、头像 ---------- */
  var Avatars = {
    image: function () {
      var v = Settings.get("avatar");
      return typeof v === "string" ? v : "";
    },
    set: function (dataUrl) { Settings.set("avatar", dataUrl || ""); },
    reset: function () { Settings.set("avatar", ""); },
    /* 文字头像：辩论=辩，宣泄=听（默认值） */
    text: function () { return Settings.get("mode") === "vent" ? "听" : "辩"; },
    /* 把头像应用到某个 .avatar 元素上 */
    apply: function (el, role) {
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
      var img = Avatars.image();
      if (img) {
        el.textContent = "";
        el.style.backgroundImage = "url(\"" + img + "\")";
        el.classList.add("has-image");
      } else {
        el.textContent = Avatars.text();
        el.style.backgroundImage = "";
        el.classList.remove("has-image");
      }
    }
  };

  /* ---------- 五、收藏 ---------- */
  var Favorites = {
    list: function () { return list(KEYS.favorites); },
    has: function (text) {
      return Favorites.list().some(function (f) { return f.text === text; });
    },
    add: function (item) {
      if (!item || !item.text) return false;
      if (Favorites.has(item.text)) return false;
      unshift(KEYS.favorites, {
        id: Utils.uid(),
        role: item.role || "assistant",
        text: String(item.text).slice(0, 2000),
        mode: item.mode || "debate",
        ts: Date.now()
      }, 300);
      return true;
    },
    remove: function (id) {
      write(KEYS.favorites, Favorites.list().filter(function (f) { return f.id !== id; }));
    },
    clear: function () { del(KEYS.favorites); }
  };

  /* ---------- 六、投票 ---------- */
  var Votes = {
    list: function () { return list(KEYS.votes); },
    add: function (v) {
      unshift(KEYS.votes, {
        id: Utils.uid(),
        round: v.round || 0,
        side: v.side === "mine" ? "mine" : "rival",
        persona: v.persona || "",
        ts: Date.now()
      }, 500);
    },
    stats: function () {
      var mine = 0, rival = 0;
      Votes.list().forEach(function (v) { if (v.side === "mine") mine++; else rival++; });
      return { mine: mine, rival: rival, total: mine + rival };
    },
    clear: function () { del(KEYS.votes); }
  };

  /* ---------- 七、计分板 ---------- */
  var Score = {
    get: function () {
      var s = read(KEYS.score, null);
      return s && typeof s === "object" ? { mine: Number(s.mine) || 0, rival: Number(s.rival) || 0 } : { mine: 0, rival: 0 };
    },
    change: function (side, delta) {
      var s = Score.get();
      var k = side === "rival" ? "rival" : "mine";
      s[k] = s[k] + (Number(delta) || 0);
      write(KEYS.score, s);
      return s;
    },
    reset: function () { del(KEYS.score); }
  };

  /* ---------- 八、收藏辩题 ---------- */
  var Topics = {
    list: function () { return list(KEYS.topics); },
    has: function (text) { return Topics.list().some(function (t) { return t.text === text; }); },
    add: function (text) {
      if (!text || Topics.has(text)) return false;
      unshift(KEYS.topics, { id: Utils.uid(), text: String(text), ts: Date.now() }, 100);
      return true;
    },
    remove: function (id) {
      write(KEYS.topics, Topics.list().filter(function (t) { return t.id !== id; }));
    },
    clear: function () { del(KEYS.topics); }
  };

  /* ---------- 九、成就徽章 ---------- */
  var Badges = {
    ids: function () {
      var v = read(KEYS.badges, []);
      return Array.isArray(v) ? v : [];
    },
    has: function (id) { return Badges.ids().indexOf(id) >= 0; },
    unlock: function (id) {
      if (!id || Badges.has(id)) return false;
      var arr = Badges.ids();
      arr.push(id);
      write(KEYS.badges, arr);
      return true;
    },
    clear: function () { del(KEYS.badges); }
  };

  /* ---------- 十、情绪标签 ---------- */
  var Tags = {
    data: function () {
      var d = read(KEYS.tags, null);
      return d && typeof d === "object" && d.counts ? d : { counts: {}, records: [] };
    },
    add: function (tag) {
      if (!tag) return;
      var d = Tags.data();
      d.counts[tag] = (Number(d.counts[tag]) || 0) + 1;
      d.records.unshift({ tag: tag, ts: Date.now() });
      if (d.records.length > 300) d.records.length = 300;
      write(KEYS.tags, d);
    },
    /* 返回 [{tag, count}]，按次数降序 */
    wall: function () {
      var c = Tags.data().counts;
      return Object.keys(c).map(function (k) { return { tag: k, count: c[k] }; })
        .sort(function (a, b) { return b.count - a.count; });
    },
    total: function () {
      var d = Tags.data();
      return Object.keys(d.counts).reduce(function (n, k) { return n + (Number(d.counts[k]) || 0); }, 0);
    },
    clear: function () { del(KEYS.tags); }
  };

  /* ---------- 十一、涂鸦 ---------- */
  var Drawings = {
    list: function () { return list(KEYS.drawings); },
    add: function (dataUrl, note) {
      var arr = Drawings.list();
      arr.unshift({ id: Utils.uid(), data: dataUrl, note: note || "", ts: Date.now() });
      while (arr.length > 6) arr.pop(); // 控制体积：最多留 6 张
      write(KEYS.drawings, arr);
    },
    remove: function (id) {
      write(KEYS.drawings, Drawings.list().filter(function (d) { return d.id !== id; }));
    },
    clear: function () { del(KEYS.drawings); }
  };

  /* ---------- 十二、时光留言 ---------- */
  var Letters = {
    list: function () { return list(KEYS.letters); },
    add: function (text) {
      if (!text) return false;
      unshift(KEYS.letters, { id: Utils.uid(), text: String(text).slice(0, 1000), ts: Date.now() }, 100);
      return true;
    },
    remove: function (id) {
      write(KEYS.letters, Letters.list().filter(function (l) { return l.id !== id; }));
    },
    clear: function () { del(KEYS.letters); }
  };

  /* ---------- 十三、会话（两种模式各存一份） ---------- */
  var Session = {
    key: function (mode) {
      return (mode || Settings.get("mode")) === "vent" ? KEYS.sessionVent : KEYS.sessionDebate;
    },
    load: function (mode, systemPrompt) {
      var key = Session.key(mode);
      var arr = read(key, null);
      if (Array.isArray(arr) && arr.length) {
        if (!arr[0] || arr[0].role !== "system") {
          arr.unshift({ role: "system", content: systemPrompt || "" });
        }
        return arr;
      }
      return [{ role: "system", content: systemPrompt || "" }];
    },
    save: function (mode, history) {
      write(Session.key(mode), history);
    },
    clear: function (mode) { del(Session.key(mode)); }
  };

  /* ---------- 十四、网络状态 ---------- */
  var Net = {
    isOnline: function () { return global.navigator.onLine !== false; },
    watch: function (cb) {
      function run() { cb(Net.isOnline()); }
      global.addEventListener("online", run);
      global.addEventListener("offline", run);
      run();
    }
  };

  /* ---------- 十五、通用工具 ---------- */
  var Utils = {
    uid: function () {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    },
    escapeHtml: function (text) {
      var map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
      return String(text == null ? "" : text).replace(/[&<>"']/g, function (ch) { return map[ch]; });
    },
    fmtTime: function (ts) {
      var d = ts ? new Date(ts) : new Date();
      function p(n) { return n < 10 ? "0" + n : "" + n; }
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
        " " + p(d.getHours()) + ":" + p(d.getMinutes());
    },
    /* 下载文本文件（导出对话 / 摘要） */
    download: function (filename, text, mime) {
      try {
        var blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 200);
        return true;
      } catch (e) {
        return false;
      }
    },
    /* 复制文本：优先 Clipboard API，降级 execCommand */
    copy: function (text) {
      var str = String(text == null ? "" : text);
      if (global.navigator.clipboard && global.navigator.clipboard.writeText) {
        return global.navigator.clipboard.writeText(str).catch(function () { return Utils.copyFallback(str); });
      }
      return Utils.copyFallback(str);
    },
    copyFallback: function (str) {
      return new Promise(function (resolve, reject) {
        try {
          var ta = document.createElement("textarea");
          ta.value = str;
          ta.setAttribute("readonly", "");
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          ta.setSelectionRange(0, str.length);
          var ok = document.execCommand("copy");
          document.body.removeChild(ta);
          ok ? resolve(true) : reject(new Error("copy failed"));
        } catch (e) {
          reject(e);
        }
      });
    }
  };

  /* ---------- 十六、分项重置 ---------- */
  var RESET_MAP = {
    favorites: [KEYS.favorites],
    badges: [KEYS.badges],
    tags: [KEYS.tags],
    votes: [KEYS.votes],
    score: [KEYS.score],
    topics: [KEYS.topics],
    drawings: [KEYS.drawings],
    letters: [KEYS.letters],
    sessions: [KEYS.sessionDebate, KEYS.sessionVent],
    settings: [KEYS.settings]
  };
  function resetData(name) {
    var keys = RESET_MAP[name] || [];
    keys.forEach(del);
  }

  /* ---------- 导出 ---------- */
  global.DDHStore = {
    KEYS: KEYS,
    Settings: Settings,
    Avatars: Avatars,
    Favorites: Favorites,
    Votes: Votes,
    Score: Score,
    Topics: Topics,
    Badges: Badges,
    Tags: Tags,
    Drawings: Drawings,
    Letters: Letters,
    Session: Session,
    Net: Net,
    Utils: Utils,
    resetData: resetData
  };
})(window);