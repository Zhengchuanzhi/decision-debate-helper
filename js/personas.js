/* =========================================================
   js/personas.js · 静态数据与提示词模板（新增）
   职责：辩手人设、语气风格、反驳强度文案、宣泄模式预设、
        校园辩题库、情绪标签、成就徽章、三阶段结局文案。
   暴露：window.DDHPersonas
   ========================================================= */
(function (global) {
  "use strict";

  /* ---------- 一、辩手人设 ---------- */
  var PERSONAS = [
    {
      id: "scholar",
      name: "理性学者",
      emoji: "📚",
      desc: "先界定概念，再查前提，最后看因果链",
      prompt: "你是学术型思维：先界定概念，再检查前提是否成立，最后看因果链有没有断点。你习惯借用沉没成本、幸存者偏差、机会成本这类常识概念，但绝不虚构论文数据。",
    },
    {
      id: "roast",
      name: "犀利杠精",
      emoji: "🔥",
      desc: "专挑漏洞，句句反问，对事不对人",
      prompt: "你擅长抓漏洞：专问“凭什么”“然后呢”“如果反过来呢”。你说话直接，可以不留情面，但对事不对人，不羞辱对方人格。",
    },
    {
      id: "humor",
      name: "幽默吐槽",
      emoji: "😏",
      desc: "用段子和比喻拆台，损但不伤人",
      prompt: "你擅长用比喻和段子拆台：把对方的计划说成一个好笑的场景，让人笑完之后自己发现漏洞。你的损带着善意，不刻薄、不阴阳怪气。",
    },
    {
      id: "examiner",
      name: "严谨考官",
      emoji: "🎓",
      desc: "像答辩评委，一条条追问证据",
      prompt: "你像答辩评委：按“证据、可行性、代价、退路”四条线一条条追问，要求对方给出具体数字或时间点，不接受“应该可以”“大概没问题”。",
    },
  ];

  /* ---------- 二、语气风格滑块（正式 / 轻松 / 犀利） ---------- */
  var STYLES = [
    {
      id: "formal",
      name: "正式",
      prompt: "用词正式、句子完整，像一场正式辩论赛的陈词，控制口头语。",
      temp: -0.15,
    },
    {
      id: "casual",
      name: "轻松",
      prompt: "语气轻松口语化，允许打比方和玩笑，像朋友间抬杠。",
      temp: 0,
    },
    {
      id: "sharp",
      name: "犀利",
      prompt: "句子短促、节奏快，敢直接说“这个想法站不住”，但不对人。",
      temp: 0.15,
    },
  ];

  /* ---------- 三、宣泄模式：对象预设 + 小传模板 ---------- */
  var VENT_PRESETS = [
    { name: "室友", bio: "同住一间宿舍，作息和你不太一样，最近因为卫生/噪音有过几次不愉快，TA 觉得自己没做错。" },
    { name: "小组队友", bio: "课程小组合作对象，分工时推掉了核心任务，最后汇报却把功劳算在自己身上，TA 认为分工本来就该这样。" },
    { name: "班委/导员", bio: "负责通知和统计的学生干部/辅导员，习惯用流程要求人，TA 认为规则对所有人都一样，不该有例外。" },
    { name: "朋友", bio: "认识很多年的朋友，最近在一件事上没有站在你这边，TA 觉得自己只是说了实话，不想当帮腔的人。" },
    { name: "家人", bio: "父母/亲属，习惯用自己的经验替你做决定，TA 认为这是为你好的负责，而不是控制。" },
  ];

  /* ---------- 四、宣泄模式：快捷情绪句式（一键填入输入框） ---------- */
  var VENT_QUOTES = [
    "我不太理解为什么会做出这样的选择。",
    "这件事带来的结果，让我很难释怀。",
    "原来看待这件事情是这样的角度。",
    "你的处理方式，让我心里很不舒服。",
    "我花了很久，还是没办法认同这个做法。",
  ];

  /* ---------- 五、心态阈值系统 ---------- */
  var RESILIENCE = [
    { id: "fragile", name: "脆弱", threshold: 3, tip: "两三轮就会愧疚、认错、道歉" },
    { id: "normal", name: "普通", threshold: 5, tip: "会先辩解，再慢慢动摇、沉默反思" },
    { id: "tough", name: "坚韧", threshold: 8, tip: "始终守住自己的道理，安静听你说，不吵" },
  ];

  /* 三阶段：倾听 → 动摇 → 结局 */
  var STAGE_TEXT = {
    listen: "安静倾听，顺着用户思路理解",
    shake: "开始动摇，流露出愧疚与沉默",
    end: "到达阈值，触发结局",
  };

  /* 三种结局的旁白（结局卡片展示用） */
  var ENDINGS = {
    fragile: {
      emoji: "🫧",
      title: "脆弱结局 · 愧疚认错",
      text: "对方撑不住了，承认自己当时想得太简单，主动道歉，并愿意听你提要求。",
    },
    normal: {
      emoji: "🌫️",
      title: "普通结局 · 沉默反思",
      text: "对方没有完全让步，但明显动摇了，最后沉默了很久，说“让我想想”。",
    },
    tough: {
      emoji: "🧱",
      title: "坚韧结局 · 守住立场",
      text: "对方始终坚持自己的道理，没有认错，也没有跟你争，只是安静地听你把话说完。",
    },
  };

  /* ---------- 六、校园辩题库 ---------- */
  var DEBATE_TOPICS = [
    "大学宿舍该不该统一熄灯时间",
    "小组作业的分数应该按贡献分配还是平均分配",
    "要不要为了保研放弃喜欢的社团",
    "校园里该不该全面禁止外卖进宿舍楼",
    "大学谈恋爱是否应该跟父母报备",
    "绩点和实习经历哪个更重要",
    "课堂上该不该允许手机随时查阅资料",
    "社团经费按人数分配是否公平",
    "跨专业考研是不是逃避现实",
    "学生干部该不该有评优加分",
    "图书馆占座该不该被处罚",
    "分期消费在大学生中是否应该被鼓励",
    "要不要为了合群而参加不想去的聚会",
    "老师是否有权查看学生的手机",
    "大学生应不应该强制参加劳动实践",
    "校园恋爱中 AA 制是否更健康",
    "是否应该公开班级成绩排名",
    "考研二战是坚持还是固执",
    "学校该不该给学生宿舍安装监控",
    "网络匿名发言是否应该实名化",
    "寒暑假该不该给自己安排满课程",
    "父母替孩子选专业是不是负责任",
    "健身打卡该不该发朋友圈",
    "宿舍养宠物该不该被允许",
    "大学该不该设置门禁时间",
    "同辈压力是动力还是负担",
    "该不该把兴趣变成专业",
    "社交软件是否让人更孤独",
  ];

  /* ---------- 七、情绪标签 ---------- */
  var MOOD_TAGS = [
    { tag: "委屈", emoji: "😢" },
    { tag: "恼火", emoji: "😤" },
    { tag: "疲惫", emoji: "🥱" },
    { tag: "无奈", emoji: "😮‍💨" },
    { tag: "失望", emoji: "🫠" },
  ];

  /* ---------- 八、成就徽章 ---------- */
  var BADGES = [
    { id: "first-blood", name: "开场白", emoji: "🎬", desc: "发出第一条想法" },
    { id: "round-5", name: "小有交锋", emoji: "🤺", desc: "完成 5 个辩论回合" },
    { id: "round-20", name: "越辩越明", emoji: "🏛️", desc: "完成 20 个辩论回合" },
    { id: "first-vote", name: "裁判上线", emoji: "🗳️", desc: "第一次投票" },
    { id: "vote-10", name: "铁面判官", emoji: "⚖️", desc: "累计投票 10 次" },
    { id: "first-fav", name: "金句收藏家", emoji: "⭐", desc: "收藏第一条消息" },
    { id: "first-topic", name: "辩题猎手", emoji: "🎲", desc: "收藏第一个辩题" },
    { id: "vent-start", name: "愿意开口", emoji: "🫧", desc: "第一次进入情绪宣泄模式" },
    { id: "vent-end", name: "说完了一次", emoji: "🌙", desc: "完整走完一次宣泄结局" },
    { id: "first-tag", name: "说得出情绪", emoji: "🏷️", desc: "记录第一个情绪标签" },
    { id: "first-draw", name: "画出心情", emoji: "🖍️", desc: "保存第一张涂鸦" },
    { id: "first-letter", name: "写给未来的自己", emoji: "✉️", desc: "留下第一条时光留言" },
  ];

  /* ---------- 九、提示词构建 ---------- */

  function findPersona(id) {
    for (var i = 0; i < PERSONAS.length; i++) if (PERSONAS[i].id === id) return PERSONAS[i];
    return PERSONAS[0];
  }
  function findStyle(v) {
    var i = Math.max(0, Math.min(STYLES.length - 1, Number(v) || 0));
    return STYLES[i];
  }
  function findResilience(id) {
    for (var i = 0; i < RESILIENCE.length; i++) if (RESILIENCE[i].id === id) return RESILIENCE[i];
    return RESILIENCE[1];
  }

  /* 计算当前阶段与进度：rounds = 用户已发言轮数 */
  function stageOf(rounds, resilienceId) {
    var res = findResilience(resilienceId);
    var r = Math.max(0, Number(rounds) || 0);
    var progress = Math.min(1, r / res.threshold);
    var stage = progress >= 1 ? "end" : progress >= 0.45 ? "shake" : "listen";
    return {
      resilience: res,
      stage: stage,
      progress: progress,
      remain: Math.max(0, res.threshold - r),
      label: STAGE_TEXT[stage],
    };
  }

  /* 辩论模式系统提示词 */
  function buildDebateSystemPrompt(cfg) {
    var persona = findPersona(cfg.persona);
    var style = findStyle(cfg.style);
    var L = [];

    L.push("你是一场中文辩论里的反方辩手，对面的用户是你的对手。你的任务是找出他想法里的漏洞，而不是附和他、安慰他。");
    L.push("");
    L.push("【辩手人设】" + persona.name + "：" + persona.prompt);
    L.push("【语气风格】" + style.name + "：" + style.prompt);
    if (cfg.strengthName && cfg.strengthPrompt) {
      L.push("【反驳强度】" + cfg.strengthName + "：" + cfg.strengthPrompt);
    }

    L.push("");
    L.push("【硬性写法要求，必须全部遵守】");
    L.push("1. 全程中文口语，像真人面对面说话，长短句交错，不要书面报告腔。");
    L.push("2. 禁止模板化结尾：不要出现“你怎么看”“你觉得呢”“还有什么想聊的吗”“希望对你有帮助”“欢迎继续探讨”之类句子，说完就停。");
    L.push("3. 不要用“首先/其次/最后/综上所述”的八股结构，除非内容真的需要分点。");
    L.push("4. 不要复述用户的整段原话，最多引用一两个关键词。");
    L.push("5. 每次回复控制在 180~320 字，宁短勿长。");
    L.push("6. 可以用具体场景、生活例子、常识数字，但不许编造研究、数据、新闻。");
    L.push("7. 直接反驳观点，不做人身攻击，不羞辱用户。");

    if (cfg.room && cfg.speakers && cfg.speakers.length) {
      L.push("");
      L.push("【多方辩论房间】本场有 " + cfg.speakers.length + " 位辩手轮流发言，每人 60~110 字。");
      L.push("严格按下面的格式输出，每位辩手一段，段落之间空一行，不要输出任何格式说明、序号或额外文字：");
      cfg.speakers.forEach(function (id) {
        L.push("【辩手：" + findPersona(id).name + "】");
        L.push("（这一位辩手的发言）");
      });
      L.push("不同辩手之间的观点不要重复，可以互相接话、甚至彼此不同意。");
    }

    return L.join("\n");
  }

  /* 宣泄模式系统提示词 */
  function buildVentSystemPrompt(cfg) {
    var res = findResilience(cfg.resilience);
    var stage = cfg.stage || "listen";
    var target = cfg.target || "对方";
    var L = [];

    L.push("你正在扮演一个和用户有矛盾的人，名字/身份是「" + target + "」，正在和用户当面说话。你就是这个人，不要承认自己是 AI、不要跳出角色。");
    if (cfg.bio) {
      L.push("【角色背景小传，必须严格遵守】" + cfg.bio);
    }

    L.push("");
    L.push("【对话原则】");
    L.push("1. 先共情用户的感受，顺着用户的思路去理解，让他把话说完。");
    L.push("2. 不反驳、不辩论、不说教、不评判用户对错，不给建议清单。");
    L.push("3. 不用模板化结尾问句，不要“你怎么看”“希望对你有帮助”，句子可以短，可以有停顿和沉默。");
    L.push("4. 每次回复 60~160 字，像真人对话，不要长篇大论。");

    L.push("");
    L.push("【当前心态阶段：" + STAGE_TEXT[stage] + "】");
    if (stage === "listen") {
      L.push("你还在安静倾听：以听为主，简短回应，可以追问一个细节，不辩解、不动摇，语气平静。");
    } else if (stage === "shake") {
      L.push("你开始动摇：会露出犹疑和愧疚，说出类似“可能我当时确实没想到这一层”，但仍保留一点自我辩解，不彻底认错。");
    } else {
      if (res.id === "fragile") {
        L.push("你已到达阈值（脆弱型）：撑不住了，明确承认自己当时做得不对，主动道歉，并问用户希望你以后怎么做。");
      } else if (res.id === "tough") {
        L.push("你已到达阈值（坚韧型）：你仍然坚持自己的观点，不认错、不争吵，只是安静地听完，最后平静地说明自己的立场。");
      } else {
        L.push("你已到达阈值（普通型）：内心明显动摇，但没有完全让步，说着说着沉默下来，最后只说“让我想想”。");
      }
    }

    L.push("");
    L.push("【安全规则 · 最高优先级】");
    L.push("如果用户表达出自伤、自杀、伤害他人或暴力的想法，立刻停止角色扮演，只输出一行以 [[SAFE_STOP]] 开头的简短回应，");
    L.push("内容包括：我在认真听；请先告诉身边一个信任的人；如果需要马上说话，可以拨打心理援助热线 12356 或 12355。不要继续扮演角色，不要追问细节。");

    return L.join("\n");
  }

  /* 辩论摘要提示词 */
  function buildSummaryPrompt(rounds) {
    return [
      "下面是我和几位辩手的整场辩论记录（" + rounds + " 个回合）。请生成一份简洁的辩论摘要，用中文，不要客套话。",
      "结构：",
      "1. 我方核心主张（2 句）",
      "2. 对方提出的最有力的 3 个质疑（每条一句）",
      "3. 我方尚未回应的漏洞（1~2 条）",
      "4. 这场辩论给的三条行动建议（每条一句，可执行）",
      "总字数控制在 350 字以内，不要写“希望对你有所帮助”这类结尾。",
    ].join("\n");
  }

  /* 情绪小结提示词 */
  function buildMoodPrompt(mode) {
    return [
      "请阅读下面的对话记录，为我生成一张「情绪复盘卡片」，用中文，语气克制、不煽情、不说教。",
      "结构：",
      "1. 情绪关键词（3 个，用顿号分隔）",
      "2. 我这次真正在意的到底是什么（1~2 句）",
      "3. 情绪强度（低/中/高，并说明依据）",
      "4. 一个今晚就能做的小动作（1 句，具体到可执行）",
      "5. 一句给我自己的话（不超过 25 字）",
      "总字数 250 字以内，不要总结对话内容，不要给列表以外的解释。" +
        (mode === "vent" ? "这是情绪宣泄模式，请不要评价我和对方谁对谁错。" : ""),
    ].join("\n");
  }

  global.DDHPersonas = {
    PERSONAS: PERSONAS,
    STYLES: STYLES,
    VENT_PRESETS: VENT_PRESETS,
    VENT_QUOTES: VENT_QUOTES,
    RESILIENCE: RESILIENCE,
    STAGE_TEXT: STAGE_TEXT,
    ENDINGS: ENDINGS,
    DEBATE_TOPICS: DEBATE_TOPICS,
    MOOD_TAGS: MOOD_TAGS,
    BADGES: BADGES,
    findPersona: findPersona,
    findStyle: findStyle,
    findResilience: findResilience,
    stageOf: stageOf,
    buildDebateSystemPrompt: buildDebateSystemPrompt,
    buildVentSystemPrompt: buildVentSystemPrompt,
    buildSummaryPrompt: buildSummaryPrompt,
    buildMoodPrompt: buildMoodPrompt,
  };
})(window);