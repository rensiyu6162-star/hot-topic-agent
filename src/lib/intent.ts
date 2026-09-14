// 意图路由（2026-09 从 app/api/chat/route.ts 抽出，便于离线测试确定性闸）。
//
// 设计原则（意图路由三步根治的沉淀）：
// 1. LLM 意图分类器是 intent 的【唯一权威】，temperature=0，不允许任何正则快通道分流；
// 2. 分类器提取的每个名字/领域都必须能在用户原话（或指定的上文范围）里【逐字核验】，
//    权威判意图、闸防臆想与张冠李戴——不做任何近义词映射；
// 3. 猜不准时走安全出口：分类器挂掉只认封闭性强的动作词（抓/拉/排行榜）兜底，
//    弱话题词（很火/热门/大瓜）绝不触发抓榜——chat 误判成 hot 会用热榜顶掉提问，代价不对称；
// 4. 本轮产出 turnType 邮戳（hotboard/overview/other），随响应回传、下一轮由客户端原样带回，
//    路由不再靠正则识别己方上一轮的输出散文。

export type TurnType = "hotboard" | "overview" | "other";
export type LastTurnType = TurnType | "none";

// 明确产出动作（写稿/润色/翻译等）；同时被 chat route 的任务泄漏截除复用，故导出。
export const TASK_VERB_RE =
  /润色|改写|翻译|扩写|缩写|校对|改错|续写|帮我写|帮我改|帮我把|帮我润|帮我出|写一段|写一篇|写一条|写一版|写个|写份|写稿|来一篇|来一版|稿子|起个标题|取个标题|开场白|口播稿|文案|视频脚本|短视频脚本|分镜/;

// 明确要数据的祈使动作（分类器不可用时的兜底；弱话题词不在此列）
const FETCH_DATA_RE =
  /抓一下|抓取|抓点|抓个|帮我抓|给我抓|拉一下|拉取|热榜|榜单|排行榜|有什么可写|有啥可写|有什么.{0,6}(热点|选题)|有啥.{0,6}(热点|选题)/;

export interface ClassifyInput {
  lastUserContent: string;
  priorContextText: string; // 本轮用户消息之前的全部上文（逐字闸的上文范围）
  lastAssistantExcerpt: string; // 助手最近一条回复节选（喂分类器）
  lastTurnType: LastTurnType; // 上一轮结构（客户端邮戳优先，正则推断兜底，已由 route 算好）
  // 全部可用领域（系统清单 + 用户自创 glossary 键）
  domainUniverse: string[];
  // 分类器调用注入：route 侧绑定本请求的 LLM 配置，temperature 必须为 0
  classify: (prompt: string) => Promise<string>;
}

export interface IntentDecision {
  clsOk: boolean; // 分类器是否成功（false=走了动作词兜底）
  isHotRequest: boolean;
  isTaskRequest: boolean;
  clsEntity: boolean; // 分类器判 entity（含 followup）
  entityFollowup: boolean; // entity followup 且未被跨主体闸扳回
  chatSubject: string; // 通过逐字闸的主体名（entity/chat 轮事实预取用）
  subjectQualifier: string; // 多义选定词（"电竞的"→电竞）
  msgDomains: string[]; // 本轮逐字点名的领域（入口确定性提取 + 分类器提取合并）
  auxTopics: string[]; // 抓榜消息顺带提及的附加话题（≤2）
  turnType: TurnType; // 本轮邮戳
}

export async function classifyTurn(
  input: ClassifyInput
): Promise<IntentDecision> {
  const {
    lastUserContent,
    priorContextText,
    lastAssistantExcerpt,
    lastTurnType,
    classify,
  } = input;
  const universe = Array.from(new Set(input.domainUniverse.filter(Boolean)));

  // 本轮逐字点名的领域（清单内词在用户原话出现即命中；清单外词由分类器提取后同样逐字校验）
  const msgDomains: string[] = Array.from(
    new Set(
      universe.filter((d) => d && d.length > 1 && lastUserContent.includes(d))
    )
  );
  const auxTopics: string[] = [];

  let clsOk = false;
  let isHotRequest = false;
  let isTaskRequest = false;
  let clsEntity = false;
  let entityFollowup = false;
  let chatSubject = "";
  let subjectQualifier = "";
  let turnType: TurnType = "other";

  if (lastUserContent.trim()) {
    try {
      const clsRes = await classify(buildClassifierPrompt({
        universe,
        lastTurnType,
        lastAssistantExcerpt,
        lastUserContent,
      }));
      const m = String(clsRes || "").match(/\{[\s\S]*\}/);
      if (m) {
        const obj = JSON.parse(m[0]);
        if (obj && typeof obj === "object") {
          // 分类器是本轮 intent 的唯一权威；提取的名字/领域仍要过原文逐字校验闸。
          clsOk = true;
          isHotRequest = obj.intent === "hot";
          if (obj.intent === "task") isTaskRequest = true;
          if (obj.intent === "entity") clsEntity = true;
          if (obj.intent === "hot") turnType = "hotboard";
          else if (obj.intent === "entity" && obj.mode === "intro")
            turnType = "overview";

          const lowCur = lastUserContent.toLowerCase();
          const lowHist = priorContextText.toLowerCase();

          // qualifier 先于 subject 校验：多义含义选定轮的主体名只在上文、不在本轮原话，
          // qualifier 在本轮逐字出现即为真实输入凭证，subject 闸据此放宽到上文历史。
          if (obj.intent === "entity" && typeof obj.qualifier === "string") {
            const qf = obj.qualifier.trim().slice(0, 12);
            if (qf && lowCur.includes(qf.toLowerCase()))
              subjectQualifier = qf;
          }
          // subject 逐字校验闸：本轮原话，或 followup/多义选定轮放宽到上文历史。
          if (
            (obj.intent === "chat" || obj.intent === "entity") &&
            typeof obj.subject === "string"
          ) {
            const s = obj.subject.trim().slice(0, 40);
            const allowHist =
              obj.mode === "followup" || subjectQualifier.length > 0;
            const verbatimOk =
              s.length > 0 &&
              (lowCur.includes(s.toLowerCase()) ||
                (allowHist && lowHist.includes(s.toLowerCase())));
            if (verbatimOk) chatSubject = s;
          }
          // prevSubject 逐字校验
          let prevSubjectVerified = "";
          if (typeof obj.prevSubject === "string") {
            const ps = obj.prevSubject.trim().slice(0, 40);
            if (ps && lowHist.includes(ps.toLowerCase()))
              prevSubjectVerified = ps;
          }
          // followup 跨主体结构闸：followup 是代词封闭集合，若 subject 与 prevSubject 不同
          // 且新名字明写在本轮 → 实为新主体指称查询，确定性扳回 intro（触发该主体预取）。
          if (obj.intent === "entity" && obj.mode === "followup") {
            const sInCur =
              !!chatSubject && lowCur.includes(chatSubject.toLowerCase());
            const crossToNewName =
              !!prevSubjectVerified &&
              !!chatSubject &&
              chatSubject !== prevSubjectVerified &&
              sInCur;
            entityFollowup = !crossToNewName;
            if (crossToNewName) turnType = "overview";
          }
          if (obj.intent === "hot" && Array.isArray(obj.domains)) {
            const lowMsg = lastUserContent.toLowerCase();
            const picks: string[] = (obj.domains as unknown[])
              .map((x) => String(x).trim())
              .filter(
                (x) => x.length >= 2 && lowMsg.includes(x.toLowerCase())
              );
            msgDomains.push(
              ...Array.from(new Set<string>(picks)).filter(
                (x) => !msgDomains.includes(x)
              )
            );
          }
          if (obj.intent === "hot" && Array.isArray(obj.auxTopics)) {
            const lowMsg2 = lastUserContent.toLowerCase();
            const auxPicks: string[] = (obj.auxTopics as unknown[])
              .map((x) => String(x).trim())
              .filter(
                (x) =>
                  x.length >= 2 &&
                  lowMsg2.includes(x.toLowerCase()) &&
                  !msgDomains.includes(x)
              );
            auxTopics.push(...Array.from(new Set<string>(auxPicks)).slice(0, 2));
          }
        }
      }
    } catch {
      // 分类器失败不可静默当成功：clsOk 保持 false，下方走动作词兜底（route 另有错误日志）
    }
  }

  // 分类器不可用时的保守兜底：只认封闭性强的动作词；弱话题词不触发抓榜。
  if (!clsOk) {
    isHotRequest = FETCH_DATA_RE.test(lastUserContent);
    isTaskRequest =
      TASK_VERB_RE.test(lastUserContent) &&
      !FETCH_DATA_RE.test(lastUserContent);
    if (isHotRequest) turnType = "hotboard";
  }

  return {
    clsOk,
    isHotRequest,
    isTaskRequest,
    clsEntity,
    entityFollowup,
    chatSubject,
    subjectQualifier,
    msgDomains,
    auxTopics,
    turnType,
  };
}

function buildClassifierPrompt(args: {
  universe: string[];
  lastTurnType: LastTurnType;
  lastAssistantExcerpt: string;
  lastUserContent: string;
}): string {
  const { universe, lastTurnType, lastAssistantExcerpt, lastUserContent } =
    args;
  return `判断用户消息的意图，并提取领域与附带话题。已有领域清单（domains 优先从这里选，必须逐字保留写法）：${universe.join(
    "、"
  )}。只返回 JSON，不要任何解释：{"intent":"hot、chat、entity或task","mode":"intro或followup","domains":["领域名"],"auxTopics":["附带话题"],"subject":"核心主体名或空串","qualifier":"主体限定词或空串","prevSubject":"上文主体名或空串"}。
【上一轮结构（服务端确定性判定，权威线索，优先于你对节选文字的自行揣测）】${
    lastTurnType === "hotboard"
      ? "助手上一条回复=【各平台热榜/热点列表】"
      : lastTurnType === "overview"
        ? "助手上一条回复=【某个主体的速览/多义解释】"
        : lastTurnType === "other"
          ? "助手上一条=普通问答/产出内容"
          : "本轮没有上文"
  }。用户若发极简残句（如"X的""X呢""换X"），结合该结构判：热榜后的残句通常是【换 X 领域重抓】(intent=hot，domains 逐字填 X，subject/qualifier/prevSubject 均空串)；主体速览/多义解释后的"X的"残句通常是【选定该主体的 X 含义、按该含义重新展开】(intent=entity，mode=intro——不是 followup 追问细节，subject 填被解释的那个多义主体名，qualifier 逐字填 X，prevSubject 也填该主体名)。助手上一条节选：${lastAssistantExcerpt || "（无）"}。
⚠️【裸名词 vs "X的"残句——必须分清，最高频错判点】用户在输入框只发一个【光秃秃的话题名词】（无句末"的/呢"、无"换/来/切"、无"抓/拉/看/有什么/有啥/可写/大瓜/热点/榜单"等任何数据请求词或动词），如"女性主义""劳动法""露营""量子计算"：这不是换领域重抓，而是用户把这个话题本身抛出来【想看懂它、要切入方向】→ 一律判 intent=entity、mode=intro、subject 逐字填该词、domains=[]，【即使】该词恰好出现在领域清单里、【即使】上文是热榜、【即使】右上角选了同名领域也不变——是不是重抓只看句子本身有没有"的/呢"残句标志或抓取动作词，与清单/上文无关。只有带"的/呢"的承接残句（"女性主义的""女性主义的呢"）或明确动作句（"女性主义今天有什么热点"）才判 intent=hot。
【task 判据】用户要求产出或加工内容：写口播稿/视频脚本/文案/标题、润色、改写、翻译、扩写、缩写、续写等"帮我做X产出"请求——【消息里带具体主体也算 task】，如"zont1x年少成名、生涯坎坷的角度写口播稿"。
【核心判断原则——先分清用户要的是"数据"、"产出"还是"判断/问答"】hot=用户此刻要的是"今天的榜单数据"：想看到各平台热榜列表本身（抓取/拉取/看看今天有什么热点/找可写的选题素材）。chat=用户要的是"判断、建议、分析或方案"：问你怎么看/值不值得做/怎么办，即使消息里出现"很火""热门""大热"也不是在要榜单。
【entity 判据——具体主体聚焦】消息指向一个具体、单一、可指名的主体（人物/战队/组织/公司/作品/产品/APP/节目/店铺/地点/事件/题材均可，如选手名、队名、剧名、APP名、景点名、店名、某种现象），用户把它单独抛出、围绕它提问、或想围绕它找内容方向，且不是在要榜单数据、也不是产出任务 → entity。
【entity 的 mode】intro=用户首次点名主体/想看主体全貌（裸词点名、"X是谁"、换了个新主体）；followup=对话上文已经围绕该主体展开过、用户在追问/求证/补充某个具体信息点（如"他当时为什么被下放""再讲讲那段经历""补充一下细节"）。判断依据看上文：上文助手回复节选：${lastAssistantExcerpt || "（无上文）"}。
⚠️【新名字指称问句 = intro，不是 followup】followup 仅限用户用【代词/省略主语】指代上文主体（他/她/它/这人/那个/上面说的，这是一个封闭的代词集合）。如果用户【明确写出了一个新的名字/称谓】问"X是谁/X什么意思/X是什么梗"，哪怕上文正在聊别的人、哪怕这个名字是在上文里被顺带提到的（上文聊选手A时顺带提了另一个外号B，用户接着问"B是谁"），这都是一个【全新主体的指称查询】→ 判 entity+intro、subject 填这个新名字（B）、prevSubject 填上文正在聊的主体（A），【绝对不要】沿用上文主体（A）判 followup——否则会把新名字错按成上文那个人身边的人。
【句式判据（比话题词可靠）】先看句子的核心诉求，再数词：祈使句在要数据（抓/拉/列/给我看/今天有什么可写可挖的）→ hot；疑问句在求评价或求建议（值得…吗/值不值得/该不该/怎么看/怎么评价/怎么蹭/能不能做/要不要跟）→ chat——哪怕句子里出现"很火""爆了""有流量""热点"也不改变性质。不要数话题词，要问"用户此刻想要的是一份列表、一份产出，还是一个判断或一句回答"。
【不对称代价规则】把 chat 误判成 hot，用户正常的提问会被一整份热榜顶掉，是严重错误；因此 hot 与 chat 之间拿不准一律判 chat。entity 与 chat 拿不准时：上文明显已在聊该主体且本轮在问细节 → entity+followup；是全新主体 → entity+intro；完全没把握有没有主体 → chat。把 followup 误判成 intro，用户只想追问一句却会重新收到一整份速览大面板，同样是严重错误。（例外：上文"新名字指称问句"规则优先——明确写新名字问"是谁/什么意思"一律 intro。）
【domains 提取——必须逐字】domains 里的每个词都必须是用户本轮消息里【逐字出现】的词（服务端会逐字校验，非原话词一律丢弃，清单内词也不豁免）：清单里的词在原话出现就逐字填；用户用近义词/换说法时（如"女权"对应清单里的"女性主义"、"打工人"对应"职场成长"），【逐字填用户原话里的那个词】（填"女权""打工人"，绝不能改写成清单词"女性主义""职场成长"——改写即猜测，会被丢弃）；用户自造的话题词（如"bl与bg大战"）同样原样提取；最多 2 个；没有明确指向就给 []；intent 为 chat、entity 或 task 时 domains 一律 []。⚠️ 承接热点轮的"X的"残句（如"电竞的""宠物的"）是在要求换成 X 领域重抓：intent 判 hot，domains 逐字提取 X（哪怕 X 不在清单里），绝不能因为消息没写全"电竞的热点"就漏提、也绝不能填上文或右上角的旧领域。
【auxTopics 提取】用户在抓热点类消息里【顺带】提到、但不作为主筛选依据的其他具体话题（如"帮我抓取今日热点，关注一下量子计算突破"里的"量子计算突破"）：原样提取放进 auxTopics（最多 2 个，保留用户写法，必须逐字出现在消息里）；没有就给 []；intent 为 chat、entity 或 task 时 auxTopics 一律 []。
【subject 提取】当 intent 为 chat 或 entity 时，提取这条消息【围绕的那个单一具体主体】的名字（人物/战队/产品/作品/APP/事件/现象均可，如"村超""Cursor""Faker""zont1x""王俊凯"）：用最简短通用的称呼（中文用中文常用名、外文用原名），只给主体名本身，不要带句子、修饰词或标点；followup 轮沿用上文主体也照样填。intent 为 hot、task，或纯寒暄（你好/谢谢/在吗）没有具体主体时，给空串 ""。
【qualifier 提取——仅一种情况非空】上文助手刚解释了一个【多义主体/多义词】的多个含义（如"487 常见的是①电竞选手②贴吧楼③老歌"），用户本轮用极简方式选定其中一个含义（"电竞的""我要电竞那个"）：把用户选定的限定词原样填入（"电竞"，必须是本轮消息里逐字出现的词），此时 intent=entity、mode=intro、subject 填被解释的主体（"487"）。除"多义含义选定"外的所有情况（包括普通 followup、普通 hot/chat/task）qualifier 一律给空串 ""。
【prevSubject 提取】对话上文【正在围绕展开】的那个主体名：通常等于最近一条【主体速览】所解释的主体（如上一条在讲 zont1x，本轮"他当时为什么被下放"→prevSubject 填"zont1x"）；本轮是对话第一句、或上文是热榜列表/普通问答而非某个主体时，给空串 ""。它只用于服务端核对"用户是在代词追问上文同一主体，还是明写了一个新名字"——务必如实填，不确定上文主体就给空串。
示例：
"帮我抓今日热点"→{"intent":"hot","mode":"intro","domains":[],"auxTopics":[],"subject":"","qualifier":"","prevSubject":""}
"今天有啥可写的？"→{"intent":"hot","mode":"intro","domains":[],"auxTopics":[],"subject":"","qualifier":"","prevSubject":""}
"帮我抓一下宠物和露营的热点"→{"intent":"hot","mode":"intro","domains":["宠物","露营"],"auxTopics":[],"subject":"","qualifier":"","prevSubject":""}
"帮我抓取今日热点，关注一下量子计算突破"→{"intent":"hot","mode":"intro","domains":[],"auxTopics":["量子计算突破"],"subject":"","qualifier":"","prevSubject":""}
"村超最近好像很火，值得做内容吗"→{"intent":"chat","mode":"intro","domains":[],"auxTopics":[],"subject":"村超","qualifier":"","prevSubject":""}
"shiro"→{"intent":"entity","mode":"intro","domains":[],"auxTopics":[],"subject":"shiro","qualifier":"","prevSubject":""}
"他当时为什么被下放"（上文刚聊过zont1x）→{"intent":"entity","mode":"followup","domains":[],"auxTopics":[],"subject":"zont1x","qualifier":"","prevSubject":"zont1x"}
"再讲讲他出道的经历"（上文刚聊过该人物）→{"intent":"entity","mode":"followup","domains":[],"auxTopics":[],"subject":"zont1x","qualifier":"","prevSubject":"zont1x"}
"花少北是谁"（上文刚给过老番茄的主体速览，老番茄文中顺带提过花少北）→{"intent":"entity","mode":"intro","domains":[],"auxTopics":[],"subject":"花少北","qualifier":"","prevSubject":"老番茄"}
"破防是什么意思"（上文在聊完全不相干的话题）→{"intent":"entity","mode":"intro","domains":[],"auxTopics":[],"subject":"破防","qualifier":"","prevSubject":""}
"zont1x年少成名，生涯坎坷，遇到好战队好队友的角度写口播稿"→{"intent":"task","mode":"intro","domains":[],"auxTopics":[],"subject":"","qualifier":"","prevSubject":""}
"帮我把上面这段润色一下"→{"intent":"task","mode":"intro","domains":[],"auxTopics":[],"subject":"","qualifier":"","prevSubject":""}
"根据bl与bg大战领域筛选热点"→{"intent":"hot","mode":"intro","domains":["bl与bg大战"],"auxTopics":[],"subject":"","qualifier":"","prevSubject":""}
"电竞的"（上文助手刚给过热榜/热点列表，用户用"X的"残句要求切换领域重抓）→{"intent":"hot","mode":"intro","domains":["电竞"],"auxTopics":[],"subject":"","qualifier":"","prevSubject":""}
"电竞的"（上文助手刚解释了一个多义词/多义主体，如"487 常见的是①电竞选手②贴吧楼③老歌"，用户用"X的"选定其中一个含义）→{"intent":"entity","mode":"intro","domains":[],"auxTopics":[],"subject":"487","qualifier":"电竞","prevSubject":"487"}
"宠物的呢"（上文助手刚给过热榜，承接热点轮的领域切换残句）→{"intent":"hot","mode":"intro","domains":["宠物"],"auxTopics":[],"subject":"","qualifier":"","prevSubject":""}
"女性主义"（上文是热榜，用户裸发话题名词、无"的/呢"无动词）→{"intent":"entity","mode":"intro","domains":[],"auxTopics":[],"subject":"女性主义","qualifier":"","prevSubject":""}
"女性主义的"（上文是热榜，带"的"的承接残句，换领域重抓）→{"intent":"hot","mode":"intro","domains":["女性主义"],"auxTopics":[],"subject":"","qualifier":"","prevSubject":""}
"露营"（无上文，用户裸发一个话题）→{"intent":"entity","mode":"intro","domains":[],"auxTopics":[],"subject":"露营","qualifier":"","prevSubject":""}
"女权圈最近有什么大瓜可以写"→{"intent":"hot","mode":"intro","domains":["女权"],"auxTopics":[],"subject":"","qualifier":"","prevSubject":""}
"看看最近打工人圈有啥热闹"→{"intent":"hot","mode":"intro","domains":["打工人"],"auxTopics":[],"subject":"","qualifier":"","prevSubject":""}
用户消息：${lastUserContent.slice(0, 300)}`;
}
