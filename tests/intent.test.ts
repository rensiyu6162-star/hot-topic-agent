// 意图路由【确定性闸】离线单测（毫秒级、零 API 调用）。
// 运行：npm i -D vitest && npx vitest run（或 npm test）
//
// 守护的不是 LLM 本身（分类器用 mock 返回固定 JSON），而是 LLM 输出之后的确定性结构：
// 逐字校验闸、跨主体结构闸、多义选定、强动作词兜底、本轮邮戳。这几处正是历史事故的根。
import { describe, it, expect } from "vitest";
import { classifyTurn, type ClassifyInput } from "../src/lib/intent";

const UNIVERSE = ["影视娱乐", "女性主义", "宠物", "露营"];

function makeInput(
  lastUserContent: string,
  cls: object | (() => never),
  overrides: Partial<ClassifyInput> = {}
): ClassifyInput {
  return {
    lastUserContent,
    priorContextText: "",
    lastAssistantExcerpt: "",
    lastTurnType: "none",
    domainUniverse: UNIVERSE,
    classify:
      typeof cls === "function"
        ? cls
        : async () => JSON.stringify(cls),
    ...overrides,
  };
}

describe("domains 逐字闸", () => {
  it("清单词在原话出现才采信", async () => {
    const d = await classifyTurn(
      makeInput("帮我抓一下宠物和露营的热点", {
        intent: "hot",
        mode: "intro",
        domains: ["宠物", "露营"],
        auxTopics: [],
        subject: "",
        qualifier: "",
        prevSubject: "",
      })
    );
    expect(d.isHotRequest).toBe(true);
    expect(d.msgDomains.sort()).toEqual(["宠物", "露营"]);
    expect(d.turnType).toBe("hotboard");
  });

  it("分类器把近义词改写成清单词（女权→女性主义）必须丢弃", async () => {
    const d = await classifyTurn(
      makeInput("女权圈最近有什么热点可以写", {
        intent: "hot",
        mode: "intro",
        domains: ["女性主义"],
        auxTopics: [],
        subject: "",
        qualifier: "",
        prevSubject: "",
      })
    );
    expect(d.msgDomains).not.toContain("女性主义");
  });

  it("用户原话原词（女权）逐字保留，不改写", async () => {
    const d = await classifyTurn(
      makeInput("女权圈最近有什么热点可以写", {
        intent: "hot",
        mode: "intro",
        domains: ["女权"],
        auxTopics: [],
        subject: "",
        qualifier: "",
        prevSubject: "",
      })
    );
    expect(d.msgDomains).toContain("女权");
  });
});

describe("subject 逐字闸", () => {
  it("subject 不在本轮原话也不在上文 → 不采信，不预取", async () => {
    const d = await classifyTurn(
      makeInput("sh1ro是谁", {
        intent: "entity",
        mode: "intro",
        domains: [],
        auxTopics: [],
        subject: "海参",
        qualifier: "",
        prevSubject: "",
      })
    );
    expect(d.chatSubject).toBe("");
    expect(d.clsEntity).toBe(true);
  });

  it("chat 咨询轮的主体在原话逐字出现 → 采信并预取", async () => {
    const d = await classifyTurn(
      makeInput("村超值得做内容吗", {
        intent: "chat",
        mode: "intro",
        domains: [],
        auxTopics: [],
        subject: "村超",
        qualifier: "",
        prevSubject: "",
      })
    );
    expect(d.chatSubject).toBe("村超");
    expect(d.isHotRequest).toBe(false);
    expect(d.turnType).toBe("other");
  });

  it("followup 的主体允许只在上文出现", async () => {
    const d = await classifyTurn(
      makeInput("他今年多大了", {
        intent: "entity",
        mode: "followup",
        domains: [],
        auxTopics: [],
        subject: "Faker",
        qualifier: "",
        prevSubject: "Faker",
      }, {
        priorContextText: "【主体速览】Faker，本名李相赫，韩国 T1 战队选手。",
        lastTurnType: "overview",
      })
    );
    expect(d.chatSubject).toBe("Faker");
    expect(d.entityFollowup).toBe(true);
    expect(d.turnType).toBe("other"); // 追问轮不弹速览
  });
});

describe("followup 跨主体结构闸", () => {
  it("上文聊A、本轮明写新名字B问是谁 → 扳回 intro，触发B预取，邮戳=overview", async () => {
    const d = await classifyTurn(
      makeInput("花少北是谁", {
        intent: "entity",
        mode: "followup", // 分类器误判成 followup
        domains: [],
        auxTopics: [],
        subject: "花少北",
        qualifier: "",
        prevSubject: "老番茄",
      }, {
        priorContextText:
          "【主体速览】老番茄，本名张秋实，B站游戏区UP主，阴阳怪气男团成员（某幻、花少北、中国boy、LexBurner、老番茄）。",
        lastTurnType: "overview",
      })
    );
    expect(d.entityFollowup).toBe(false);
    expect(d.chatSubject).toBe("花少北");
    expect(d.turnType).toBe("overview");
  });
});

describe("多义含义选定（电竞的）", () => {
  it("qualifier 本轮逐字 + subject 在上文 → 采信主体与限定词，intro 重新展开", async () => {
    const d = await classifyTurn(
      makeInput("电竞的", {
        intent: "entity",
        mode: "intro",
        domains: [],
        auxTopics: [],
        subject: "487",
        qualifier: "电竞",
        prevSubject: "487",
      }, {
        priorContextText:
          "【主体速览】487 常见的是①电竞选手 Wolves_487 何添顺②贴吧楼③老歌代号。",
        lastTurnType: "overview",
      })
    );
    expect(d.subjectQualifier).toBe("电竞");
    expect(d.chatSubject).toBe("487");
    expect(d.entityFollowup).toBe(false);
    expect(d.turnType).toBe("overview");
  });
});

describe("auxTopics 附带话题", () => {
  it("逐字出现才保留；臆想的话题丢弃", async () => {
    const d = await classifyTurn(
      makeInput("帮我抓取今日热点，关注一下量子计算突破", {
        intent: "hot",
        mode: "intro",
        domains: [],
        auxTopics: ["量子计算突破", "某个没说过的话题"],
        subject: "",
        qualifier: "",
        prevSubject: "",
      })
    );
    expect(d.auxTopics).toEqual(["量子计算突破"]);
  });
});

describe("分类器不可用时的强动作词兜底", () => {
  const boom = (() => {
    throw new Error("upstream down");
  }) as () => never;

  it("明确抓榜动作 → hot，但标记 clsOk=false", async () => {
    const d = await classifyTurn(makeInput("帮我抓取今日热点", boom));
    expect(d.clsOk).toBe(false);
    expect(d.isHotRequest).toBe(true);
    expect(d.turnType).toBe("hotboard");
  });

  it("弱话题词（大瓜/很火）不触发抓榜", async () => {
    const d = await classifyTurn(makeInput("最近大瓜好多", boom));
    expect(d.isHotRequest).toBe(false);
  });

  it("产出动作 → task，不判成 hot", async () => {
    const d = await classifyTurn(makeInput("帮我写一段口播稿", boom));
    expect(d.isTaskRequest).toBe(true);
    expect(d.isHotRequest).toBe(false);
  });
});

describe("邮戳", () => {
  it("entity intro → overview", async () => {
    const d = await classifyTurn(
      makeInput("Faker", {
        intent: "entity",
        mode: "intro",
        domains: [],
        auxTopics: [],
        subject: "Faker",
        qualifier: "",
        prevSubject: "",
      })
    );
    expect(d.turnType).toBe("overview");
  });

  it("task/chat → other", async () => {
    const d = await classifyTurn(
      makeInput("用老番茄的角度写口播稿", {
        intent: "task",
        mode: "intro",
        domains: [],
        auxTopics: [],
        subject: "",
        qualifier: "",
        prevSubject: "",
      })
    );
    expect(d.turnType).toBe("other");
  });
});
