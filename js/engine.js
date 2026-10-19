/* =========================================================
   js/engine.js · 回合调度引擎（新增）
   职责：双模式回合调度、多辩手解析、阈值推进、投票卡片、
        计分板、摘要/小结、导出、打字机、音效、徽章解锁。
   依赖：window.DDH（main.js 暴露）、DDHStore、DDHPersonas、DDHPanel
   ========================================================= */
(function (global) {
  "use strict";

  var App = null;          // 指向 window.DDH
  var Store = null;
  var P = null;            // DDHPersonas
  var mode = "debate";
  var busy = false;
  var typeToken = 0;
  var ventEnded = false;
  var safetyStop = false;
  var audioCtx = null;

  function settings() { return Store.Settings; }
  function S(k) { return Store.Settings.get(k); }

  /* ==================== 一、初始化 ==================== */
  function init() {
    App = global.DDH;
    Store = global.DDHStore;
    P = global.DDHPersonas;
    if (!App || !Store || !P) return;

    mode = S("mode") === "vent" ? "vent" : "debate";
    /* 支持 PWA 快捷方式直接进模式：index.html?mode=vent */
    try {
      var q = new URLSearchParams(global.location.search).get("mode");
      if (q === "vent" || q === "debate") mode = q;
    } catch (e) {}

    bindToolStrip();
    bindVentPanel();
    bindQuickQuotes();
    bindScoreboard();
    bindOffline();
    bindClearHook();

    applyMode(mode, { silent: true });
    renderScoreChips();
    refreshVentProgress();
  }

  /* ==================== 二、模式切换 ==================== */
  function applyMode(next, opts) {
    opts = opts || {};
    mode = next === "vent" ? "vent" : "debate";
    Store.Settings.set("mode", mode);

    document.body.classList.toggle("mode-vent", mode === "vent");
    document.body.classList.toggle("mode-debate", mode === "debate");

    var input = App.els.userInput;
    if (input) {
      input.placeholder = mode === "vent"
        ? "把你想说的话说出来，对方在听…"
        : "输入你的想法、计划或待决策事项…";
    }

    if (!opts.keepHistory) App.reloadSession();
    refreshVentProgress();
    renderScoreChips();
    if (global.DDHPanel) global.DDHPanel.refresh();

    if (!opts.silent) {
      App.ui.showToast(mode === "vent" ? "已切换到情绪宣泄模式 🫧" : "已切换到辩论模式 🎯", 1500);
      if (mode === "vent") unlockBadge("vent-start");
    }
  }

  /* ==================== 三、发送入口（主流程） ==================== */
  function submit() {
    if (!App) App = global.DDH;
    if (busy) return;
    if (safetyStop) {
      App.ui.showToast("这段对话已启动安全保护，请先点「清空对话」重新开始", 2200);
      return;
    }
    var input = App.els.userInput;
    var text = String(input.value || "").trim();
    if (!text) {
      input.focus();
      input.placeholder = "内容不能为空，请输入你的想法";
      return;
    }
    if (mode === "vent" && ventEnded) {
      App.ui.showToast("本次结局已经结束，点「清空对话」可以重新开始一场", 2200);
      return;
    }
    if (!navigator.onLine && !App.config.DEMO_MODE) {
      App.ui.showToast("离线状态：只能查看历史记录，联网后才能开始新对话", 2200);
      return;
    }
    return runTurn(text);
  }

  async function runTurn(text) {
    busy = true;
    var epoch = App.getHistory(); // 仅用于比较引用，判断是否被清空
    var history = App.getHistory();

    /* 1. 记录并渲染用户消息（沿用原有 appendMessage） */
    history.push({ role: "user", content: text });
    App.setHistory(history);
    App.ui.appendMessage("user", App.ui.escapeHtml(text), { text: text });
    App.ui.updateStats(true);
    playSound("send");

    /* 2. 清空输入框 */
    var input = App.els.userInput;
    input.value = "";
    input.placeholder = mode === "vent" ? "把你想说的话说出来，对方在听…" : "输入你的想法、计划或待决策事项…";
    App.ui.autoResizeInput();

    /* 3. 思考状态 */
    App.ui.setLoading(true);
    App.ui.appendThinkingMessage();

    try {
      var level = App.getStrengthLevel();
      var temp = Number(level.temperature) || 0.7;
      if (mode === "debate") temp += P.findStyle(S("style")).temp;

      var reply = await App.callDeepSeek(buildMessages(), temp);
      if (App.getHistory() !== history) return; // 期间被清空

      App.ui.removeThinkingMessage();
      await renderReply(reply);
      playSound("recv");

      if (mode === "vent") {
        await afterVentTurn(reply);
      } else {
        afterDebateTurn();
      }
      checkBadges();
    } catch (err) {
      if (App.getHistory() !== history) return;
      App.ui.removeThinkingMessage();
      App.ui.appendMessage("error", "⚠️ " + App.ui.escapeHtml(err.message));
    } finally {
      busy = false;
      if (App.getHistory() === history) {
        App.ui.setLoading(false);
        App.ui.scrollToBottom(true);
      }
    }
  }

  /* 组装请求消息：system + 最近 20 条历史 */
  function buildMessages() {
    var sys;
    if (mode === "vent") {
      var v = S("vent") || {};
      var rounds = countTurns();
      var info = P.stageOf(rounds, v.resilience);
      sys = P.buildVentSystemPrompt({
        target: v.target || "对方",
        bio: v.bio || "",
        resilience: v.resilience,
        stage: info.stage,
      });
    } else {
      var level = App.getStrengthLevel();
      sys = P.buildDebateSystemPrompt({
        persona: S("persona"),
        style: S("style"),
        strengthName: level.name,
        strengthPrompt: level.prompt,
        room: !!S("room"),
        speakers: roomSpeakers(),
      });
    }

    var history = App.getHistory().filter(function (m) {
      return m.role === "user" || m.role === "assistant";
    });
    if (history.length > 20) history = history.slice(-20);

    var out = [{ role: "system", content: sys }];
    history.forEach(function (m) { out.push({ role: m.role, content: m.content }); });
    return out;
  }

  function roomSpeakers() {
    var list = S("roomSpeakers");
    if (!Array.isArray(list) || !list.length) list = ["scholar", "roast", "humor"];
    var ids = list.slice(0, 4);
    if (ids.indexOf(S("persona")) < 0) ids.unshift(S("persona"));
    return ids.slice(0, 4);
  }

  /* ==================== 四、渲染回复 ==================== */
  async function renderReply(reply) {
    /* 安全兜底：自伤/暴力内容终止对话 */
    if (reply.indexOf("[[SAFE_STOP]]") >= 0 || /\[\[SAFE_STOP\]\]/.test(reply)) {
      var safeText = reply.replace(/\[\[SAFE_STOP\]\]/g, "").trim();
      renderAssistant(App.ui.escapeHtml(safeText).replace(/\n/g, "<br>"), safeText);
      pushAssistant(safeText);
      safetyStop = true;
      App.els.userInput.disabled = true;
      App.els.sendButton.disabled = true;
      renderSafetyCard();
      return;
    }

    var blocks = parseRoomBlocks(reply);

    if (mode === "debate" && S("room") && blocks.length > 1) {
      /* 多辩手轮流发言：一条历史消息，多个气泡 */
      var merged = blocks.map(function (b) { return "【" + b.name + "】\n" + b.text; }).join("\n\n");
      pushAssistant(merged);
      for (var i = 0; i < blocks.length; i++) {
        renderAssistant(App.ui.formatReply(blocks[i].text), blocks[i].text, { speaker: blocks[i].name });
        await wait(120);
      }
      return;
    }

    var plain = reply.trim();
    pushAssistant(plain);
    renderAssistant(App.ui.formatReply(plain), plain);
  }

  function pushAssistant(content) {
    var history = App.getHistory();
    history.push({ role: "assistant", content: content });
    App.setHistory(history);
  }

  /* 渲染一条 AI 气泡（支持打字机 + 辩手标签 + 收藏） */
  function renderAssistant(html, plain, opts) {
    opts = opts || {};
    var wrapper = App.ui.appendMessage("assistant", "", { text: plain });
    var bubble = wrapper.querySelector(".bubble");
    if (!bubble) return;

    var span = document.createElement("span");
    span.className = "tw-text";
    bubble.insertBefore(span, bubble.firstChild);

    if (opts.speaker) {
      var tag = document.createElement("span");
      tag.className = "speaker-tag";
      tag.textContent = opts.speaker;
      bubble.insertBefore(tag, bubble.firstChild);
    }

    if (S("typewriter") && plain.length <= 600) {
      typeOut(span, plain, html);
    } else {
      span.innerHTML = html;
    }
    App.ui.updateStats();
    App.ui.scrollToBottom();
  }

  /* 打字机逐字动画 */
  function typeOut(span, plain, html) {
    var token = ++typeToken;
    var i = 0;
    span.textContent = "";
    var timer = setInterval(function () {
      if (token !== typeToken) { clearInterval(timer); return; }
      i += 1;
      span.textContent = plain.slice(0, i);
      if (i % 10 === 0) App.ui.scrollToBottom();
      if (i >= plain.length) {
        clearInterval(timer);
        span.innerHTML = html;
        App.ui.scrollToBottom();
      }
    }, 22);
  }

  /* 解析【辩手：xxx】分块 */
  function parseRoomBlocks(text) {
    var out = [];
    var re = /【辩手[：:]\s*([^】]+)】([\s\S]*?)(?=【辩手[：:]|$)/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var name = m[1].trim();
      var body = m[2].trim();
      if (body) out.push({ name: name, text: body });
    }
    return out;
  }

  /* 安全提示卡片 */
  function renderSafetyCard() {
    var card = document.createElement("div");
    card.className = "safety-card";
    card.innerHTML =
      '<div class="safety-title">🛟 先照顾一下自己</div>' +
      '<p>我听到了，这段情绪很重。此刻先别一个人扛着：</p>' +
      '<p>· 告诉身边一个你信任的人，把刚才的话再说一遍；</p>' +
      '<p>· 若情况紧急，可拨打心理援助热线 <b>12356</b> 或青少年服务热线 <b>12355</b>。</p>' +
      '<p class="safety-note">本场对话已停止。点「清空对话」可重新开始。</p>';
    App.els.chatArea.appendChild(card);
    App.ui.scrollToBottom();
  }

  /* ==================== 五、辩论模式回合后处理 ==================== */
  function afterDebateTurn() {
    var rounds = countAssistant();
    renderVoteCard(rounds);
    if (mode === "debate") {
      unlockBadge("first-blood");
      if (rounds >= 5) unlockBadge("round-5");
      if (rounds >= 20) unlockBadge("round-20");
    }
    if (global.DDHPanel) global.DDHPanel.refresh();
  }

  /* 投票卡片 */
  function renderVoteCard(round) {
    var wrap = document.createElement("div");
    wrap.className = "vote-card";
    wrap.innerHTML =
      '<div class="vote-title">第 ' + round + ' 回合 · 这一轮谁更有道理？</div>' +
      '<div class="vote-btns">' +
      '<button class="vote-btn" type="button" data-side="mine">我方有理</button>' +
      '<button class="vote-btn" type="button" data-side="rival">对方辩手有理</button>' +
      "</div>";

    wrap.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest(".vote-btn") : null;
      if (!btn || wrap.classList.contains("voted")) return;
      var side = btn.getAttribute("data-side");
      Store.Votes.add({ round: round, side: side, persona: S("persona") });
      wrap.classList.add("voted");
      wrap.querySelector(".vote-title").textContent =
        side === "mine" ? "✓ 已记录：我方有理" : "✓ 已记录：对方辩手有理";
      var btns = wrap.querySelector(".vote-btns");
      if (btns) btns.remove();
      unlockBadge("first-vote");
      if (Store.Votes.stats().total >= 10) unlockBadge("vote-10");
      if (global.DDHPanel) global.DDHPanel.refresh();
      App.ui.showToast("投票已保存在本机", 1200);
    });

    App.els.chatArea.appendChild(wrap);
    App.ui.scrollToBottom();
  }

  /* ==================== 六、宣泄模式回合后处理 ==================== */
  async function afterVentTurn(reply) {
    var v = S("vent") || {};
    var rounds = countTurns();
    refreshVentProgress();
    unlockBadge("first-blood");

    var info = P.stageOf(rounds, v.resilience);
    if (info.stage === "shake" && !ventEnded) {
      App.ui.showToast("对方开始动摇了…", 1400);
    }
    if (info.stage === "end" && !ventEnded) {
      ventEnded = true;
      renderEndingCard(v.resilience);
      unlockBadge("vent-end");
      if (global.DDHPanel) global.DDHPanel.openTagSheet();
    }
  }

  function renderEndingCard(resilienceId) {
    var end = P.ENDINGS[resilienceId] || P.ENDINGS.normal;
    var card = document.createElement("div");
    card.className = "ending-card";
    card.innerHTML =
      '<div class="ending-emoji">' + end.emoji + "</div>" +
      '<div class="ending-title">' + end.title + "</div>" +
      '<div class="ending-text">' + end.text + "</div>" +
      '<div class="ending-actions">' +
      '<button type="button" class="mini-btn" data-act="tag">记录此刻情绪</button>' +
      '<button type="button" class="mini-btn" data-act="summary">生成情绪小结</button>' +
      "</div>";
    card.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[data-act]") : null;
      if (!btn) return;
      if (btn.getAttribute("data-act") === "tag" && global.DDHPanel) global.DDHPanel.openTagSheet();
      if (btn.getAttribute("data-act") === "summary") moodSummary();
    });
    App.els.chatArea.appendChild(card);
    App.ui.scrollToBottom();
  }

  /* 进度条 / 阶段文字 */
  function refreshVentProgress() {
    var bar = document.getElementById("ventBar");
    var label = document.getElementById("ventStageLabel");
    if (!bar && !label) return;
    var v = S("vent") || {};
    var info = P.stageOf(countTurns(), v.resilience);
    if (bar) bar.style.width = Math.round(Math.max(0.02, info.progress) * 100) + "%";
    if (label) {
      label.textContent = info.stage === "listen" ? "初期 · 安静倾听"
        : info.stage === "shake" ? "中期 · 动摇愧疚"
        : "已到达阈值 · " + info.resilience.name;
    }
    var wrap = document.getElementById("ventBarWrap");
    if (wrap) wrap.setAttribute("data-stage", info.stage);
  }

  /* ==================== 七、统计小工具 ==================== */
  function countAssistant() {
    return App.getHistory().filter(function (m) { return m.role === "assistant"; }).length;
  }
  function countTurns() {
    return App.getHistory().filter(function (m) { return m.role === "user"; }).length;
  }

  /* ==================== 八、计分板 ==================== */
  function bindScoreboard() {
    var board = document.getElementById("scoreboard");
    if (!board) return;
    board.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[data-side]") : null;
      if (!btn) return;
      Store.Score.change(btn.getAttribute("data-side"), Number(btn.getAttribute("data-delta")) || 0);
      renderScoreChips();
      App.ui.showToast("计分已更新", 900);
    });
  }

  function renderScoreChips() {
    var mine = document.getElementById("scoreMine");
    var rival = document.getElementById("scoreRival");
    var s = Store.Score.get();
    if (mine) mine.textContent = String(s.mine);
    if (rival) rival.textContent = String(s.rival);
  }

  /* ==================== 九、工具条 ==================== */
  function bindToolStrip() {
    onClick("btnTopics", openTopics);
    onClick("btnRecall", openRecall);
    onClick("btnSummary", debateSummary);
    onClick("btnScore", toggleScoreboard);
    onClick("btnFlashback", openFlashback);
    onClick("btnMood", moodSummary);
    onClick("btnDraw", function () { if (global.DDHPanel) global.DDHPanel.openDrawPad(); });
  }

  function onClick(id, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("click", fn);
  }

  function toggleScoreboard() {
    var board = document.getElementById("scoreboard");
    if (!board) return;
    board.hidden = !board.hidden;
    if (!board.hidden) renderScoreChips();
  }

  /* ==================== 十、辩题生成器 ==================== */
  function openTopics() {
    var panel = global.DDHPanel;
    if (!panel) return;
    var current = randomTopic();
    panel.openModal("🎲 校园辩题生成器", "", [
      {
        label: "换一个",
        onClick: function () { current = randomTopic(); panel.setModalBody('<div class="topic-box">' + Store.Utils.escapeHtml(current) + "</div>"); },
      },
      {
        label: "⭐ 收藏",
        onClick: function () {
          var ok = Store.Topics.add(current);
          App.ui.showToast(ok ? "已收藏这个辩题" : "这个辩题已经收藏过了", 1400);
          if (ok) { unlockBadge("first-topic"); panel.refresh(); }
        },
      },
      {
        label: "用它开辩",
        primary: true,
        onClick: function () {
          App.els.userInput.value = "辩题：" + current + "\n我的立场：";
          App.ui.autoResizeInput();
          App.els.userInput.focus();
          panel.closeModal();
        },
      },
    ], '<div class="topic-box">' + Store.Utils.escapeHtml(current) + "</div>");
  }
  function randomTopic() {
    var arr = P.DEBATE_TOPICS;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /* ==================== 十一、时光回看 ==================== */
  function openRecall() {
    var panel = global.DDHPanel;
    if (!panel) return;
    var rounds = collectRounds();
    if (!rounds.length) {
      App.ui.showToast("还没有可回看的回合", 1400);
      return;
    }
    var idx = rounds.length - 1;
    function render() {
      var r = rounds[idx];
      var html =
        '<div class="recall-head">第 ' + (idx + 1) + " / " + rounds.length + " 轮（最近一轮默认）</div>" +
        '<div class="recall-block"><div class="recall-role">我</div><div class="recall-text">' + Store.Utils.escapeHtml(r.user) + "</div></div>" +
        '<div class="recall-block"><div class="recall-role">AI</div><div class="recall-text">' + Store.Utils.escapeHtml(r.ai) + "</div></div>";
      panel.setModalBody(html);
    }
    panel.openModal("⏱ 时光回看", "", [
      { label: "上一轮", onClick: function () { if (idx > 0) { idx--; render(); } } },
      { label: "下一轮", onClick: function () { if (idx < rounds.length - 1) { idx++; render(); } } },
      { label: "关闭", primary: true, onClick: function () { panel.closeModal(); } },
    ], "");
    render();
  }

  function collectRounds() {
    var out = [];
    var cur = null;
    App.getHistory().forEach(function (m) {
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

  /* ==================== 十二、回忆闪回 ==================== */
  function openFlashback() {
    var panel = global.DDHPanel;
    if (!panel) return;
    var msgs = App.getHistory().filter(function (m) { return m.role === "user" || m.role === "assistant"; }).slice(-12).reverse();
    if (!msgs.length) {
      App.ui.showToast("还没有过往对话可以闪回", 1400);
      return;
    }
    var html = '<div class="hint">选一条过往片段，插进输入框一起讨论：</div>';
    msgs.forEach(function (m) {
      html += '<div class="list-item"><div class="li-main"><div class="li-sub">' +
        (m.role === "user" ? "我" : "对方") + "</div>" +
        Store.Utils.escapeHtml(String(m.content).slice(0, 90)) + "</div>" +
        '<button class="mini-btn" type="button" data-fb="' + encodeURIComponent(String(m.content).slice(0, 200)) + '">插入</button></div>';
    });
    panel.openModal("🕯 回忆闪回", html, [{ label: "关闭", primary: true, onClick: function () { panel.closeModal(); } }]);

    panel.modalBodyEl().addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[data-fb]") : null;
      if (!btn) return;
      var text = decodeURIComponent(btn.getAttribute("data-fb"));
      var input = App.els.userInput;
      input.value = "【回忆闪回】上次说到：“" + text + "”，这件事我还是想再说说。\n" + input.value;
      App.ui.autoResizeInput();
      panel.closeModal();
      input.focus();
    });
  }

  /* ==================== 十三、摘要 / 情绪小结 ==================== */
  async function aiNarrative(promptText, title) {
    var panel = global.DDHPanel;
    if (!navigator.onLine && !App.config.DEMO_MODE) {
      App.ui.showToast("离线状态，生成摘要需要联网", 1800);
      return;
    }
    if (panel) panel.openModal(title, '<div class="hint">正在生成，请稍候…</div>', [{ label: "关闭", primary: true, onClick: function () { panel.closeModal(); } }]);
    var history = App.getHistory().filter(function (m) { return m.role === "user" || m.role === "assistant"; });
    var transcript = history.map(function (m) {
      return (m.role === "user" ? "我：" : "AI：") + m.content;
    }).join("\n");
    try {
      var reply = await App.callDeepSeek([
        { role: "system", content: "你是一名克制、精准的中文写作助手。" },
        { role: "user", content: promptText + "\n\n——对话记录——\n" + transcript },
      ], 0.6);
      var safe = Store.Utils.escapeHtml(reply).replace(/\n/g, "<br>");
      if (panel) {
        panel.setModalBody('<div class="summary-box">' + safe + "</div>");
        panel.setModalActions([
          {
            label: "📋 复制",
            onClick: function () {
              Store.Utils.copy(reply).then(function () { App.ui.showToast("已复制到剪贴板", 1200); })
                .catch(function () { App.ui.showToast("复制失败，请长按选择文本", 1800); });
            },
          },
          { label: "关闭", primary: true, onClick: function () { panel.closeModal(); } },
        ]);
      }
    } catch (err) {
      if (panel) panel.setModalBody('<div class="error-box">生成失败：' + Store.Utils.escapeHtml(err.message) + "</div>");
    }
  }

  function debateSummary() {
    aiNarrative(P.buildSummaryPrompt(countTurns()), "📝 整场辩论摘要");
  }
  function moodSummary() {
    aiNarrative(P.buildMoodPrompt(mode), "🫧 情绪小结");
  }

  /* ==================== 十四、导出对话 ==================== */
  function exportTxt(withDrawings) {
    var lines = [];
    lines.push("决策辩论助手 · 对话导出");
    lines.push("导出时间：" + Store.Utils.fmtTime());
    lines.push("模式：" + (mode === "vent" ? "情绪宣泄模式" : "辩论模式"));
    if (mode === "debate") {
      lines.push("辩手人设：" + P.findPersona(S("persona")).name + " / 风格：" + P.findStyle(S("style")).name);
    } else {
      var v = S("vent") || {};
      lines.push("宣泄对象：" + (v.target || "（未填写）"));
    }
    lines.push("——————————————");
    var rounds = collectRounds();
    rounds.forEach(function (r, i) {
      lines.push("");
      lines.push("【第 " + (i + 1) + " 回合】");
      lines.push("我：" + r.user);
      lines.push("AI：" + r.ai);
    });
    var tags = Store.Tags.wall();
    if (tags.length) {
      lines.push("");
      lines.push("【情绪标签】" + tags.map(function (t) { return t.tag + "×" + t.count; }).join("、"));
    }
    if (withDrawings) {
      var ds = Store.Drawings.list();
      lines.push("");
      lines.push("【涂鸦附件】本机共保存 " + ds.length + " 张涂鸦（" + Store.Utils.fmtTime(ds[0] && ds[0].ts) + " 最近一张）");
      lines.push("提示：涂鸦图片请在「设置 → 涂鸦」中单独保存到相册。");
    }
    var text = lines.join("\n");
    var ok = Store.Utils.download("辩论助手对话_" + dateStamp() + ".txt", text);
    App.ui.showToast(ok ? "已导出 txt 文件" : "导出失败，请稍后重试", 1600);
  }

  function dateStamp() {
    var d = new Date();
    function p(n) { return n < 10 ? "0" + n : "" + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" + p(d.getHours()) + p(d.getMinutes());
  }

  /* ==================== 十五、音效 ==================== */
  function playSound(kind) {
    if (!S("sound")) return;
    var vol = Number(S("volume"));
    if (!vol || vol <= 0) return;
    try {
      var Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === "suspended") audioCtx.resume();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      var t = audioCtx.currentTime;
      osc.type = "sine";
      osc.frequency.setValueAtTime(kind === "send" ? 720 : 520, t);
      if (kind === "recv") osc.frequency.setValueAtTime(760, t + 0.09);
      gain.gain.setValueAtTime(Math.min(1, vol) * 0.06, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.22);
    } catch (e) {}
  }

  /* ==================== 十六、宣泄面板 / 快捷句式 ==================== */
  function bindVentPanel() {
    var target = document.getElementById("ventTarget");
    var bio = document.getElementById("ventBio");
    var res = document.getElementById("ventResilience");
    var list = document.getElementById("ventTargetList");

    /* 快捷下拉预设 */
    if (list && !list.children.length) {
      P.VENT_PRESETS.forEach(function (p) {
        var opt = document.createElement("option");
        opt.value = p.name;
        list.appendChild(opt);
      });
    }

    var v = S("vent") || {};
    if (target) {
      target.value = v.target || "";
      target.addEventListener("input", function () {
        Store.Settings.patch({ vent: { target: target.value } });
      });
      /* 选中预设时自动补一段背景小传（可编辑） */
      target.addEventListener("change", function () {
        var hit = null;
        P.VENT_PRESETS.forEach(function (p) { if (p.name === target.value) hit = p; });
        if (hit && bio && !bio.value.trim()) {
          bio.value = hit.bio;
          Store.Settings.patch({ vent: { target: target.value, bio: hit.bio } });
        }
      });
    }
    if (bio) {
      bio.value = v.bio || "";
      bio.addEventListener("input", function () {
        Store.Settings.patch({ vent: { bio: bio.value } });
      });
    }
    if (res) {
      res.value = v.resilience || "normal";
      res.addEventListener("change", function () {
        Store.Settings.patch({ vent: { resilience: res.value } });
        refreshVentProgress();
        App.ui.showToast("坚韧度已设为「" + P.findResilience(res.value).name + "」", 1400);
      });
    }
  }

  function bindQuickQuotes() {
    var box = document.getElementById("quickQuotes");
    if (!box || box.children.length) return;
    P.VENT_QUOTES.forEach(function (q) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "quote-chip";
      b.textContent = q;
      b.addEventListener("click", function () {
        var input = App.els.userInput;
        input.value = q;
        App.ui.autoResizeInput();
        input.focus();
      });
      box.appendChild(b);
    });
  }

  /* ==================== 十七、离线提示 ==================== */
  function bindOffline() {
    var banner = document.getElementById("offlineBanner");
    Store.Net.watch(function (online) {
      document.body.classList.toggle("is-offline", !online);
      if (banner) banner.hidden = online;
      var send = App.els.sendButton;
      if (send) send.disabled = !online || busy || safetyStop;
      if (!online) App.ui.showToast("已离线：只能查看历史记录", 2000);
    });
  }

  /* ==================== 十八、成就徽章 ==================== */
  function unlockBadge(id) {
    if (!id || Store.Badges.has(id)) return;
    if (!Store.Badges.unlock(id)) return;
    var def = null;
    P.BADGES.forEach(function (b) { if (b.id === id) def = b; });
    if (def) App.ui.showToast(def.emoji + " 解锁徽章：" + def.name, 2000);
    if (global.DDHPanel) global.DDHPanel.refresh();
  }

  function checkBadges() {
    if (Store.Tags.total() > 0) unlockBadge("first-tag");
    if (Store.Favorites.list().length > 0) unlockBadge("first-fav");
    if (Store.Drawings.list().length > 0) unlockBadge("first-draw");
    if (Store.Letters.list().length > 0) unlockBadge("first-letter");
    if (Store.Topics.list().length > 0) unlockBadge("first-topic");
    if (Store.Votes.stats().total > 0) unlockBadge("first-vote");
  }

  /* ==================== 十九、清空对话后的联动 ==================== */
  function bindClearHook() {
    /* 由 main.js 的 handleClear 主动调用 onConversationCleared */
  }

  function onConversationCleared() {
    ventEnded = false;
    safetyStop = false;
    typeToken += 1;
    var input = App.els.userInput;
    if (input) input.disabled = false;
    if (App.els.sendButton) App.els.sendButton.disabled = false;
    refreshVentProgress();
    /* 对话结束 → 收集情绪标签（本地存储，可在设置里查看标签墙） */
    if (global.DDHPanel) global.DDHPanel.openTagSheet();
  }

  /* ==================== 二十、对外接口 ==================== */
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  global.DDHEngine = {
    init: init,
    submit: submit,
    applyMode: applyMode,
    getMode: function () { return mode; },
    exportTxt: exportTxt,
    debateSummary: debateSummary,
    moodSummary: moodSummary,
    openTopics: openTopics,
    openRecall: openRecall,
    openFlashback: openFlashback,
    toggleScoreboard: toggleScoreboard,
    renderScoreChips: renderScoreChips,
    refreshVentProgress: refreshVentProgress,
    unlockBadge: unlockBadge,
    onConversationCleared: onConversationCleared,
    playSound: playSound,
  };
})(window);