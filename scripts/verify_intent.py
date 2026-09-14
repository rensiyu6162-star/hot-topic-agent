# -*- coding: utf-8 -*-
"""
意图路由真实 case 回归（生产冒烟）。
用法：
    $env:INTERNAL_TOKEN="内部令牌"; python scripts/verify_intent.py [BASE_URL]
说明：站点已改为公开 + 强制 BYOK；回归以【系统内部调用】身份运行（X-Internal-Token，
      与 scheduler 定时抓取同一条通道，使用系统 Key）。这是【在线冒烟】——依赖当天
      热榜内容（如 case11 要求电竞在榜），不能替代离线单测；它守护的是
      "分类器+逐字闸+结构闸"的真实端到端行为。
"""
import os
import sys
import time

import requests

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://124.223.214.209:3000"
INTERNAL_TOKEN = os.environ.get("INTERNAL_TOKEN", "")
ALL_DOMAINS = ["情感两性","职场成长","财经理财","健康养生","育儿教育","社会热点","历史文化",
               "影视娱乐","科技互联网","法制普法","宠物","露营","女性主义"]

s = requests.Session()
if INTERNAL_TOKEN:
    s.headers["X-Internal-Token"] = INTERNAL_TOKEN
    print(f"[auth] 内部调用模式 {BASE}")
else:
    print("[warn] 未提供 INTERNAL_TOKEN：无 Key 请求会被服务端拒绝（no_key）")

def chat(msgs, domain="", platforms=None):
    r = s.post(f"{BASE}/api/chat", json={
        "messages": msgs, "domain": domain,
        "platforms": platforms or ["微博","抖音","快手","小红书","百度","头条","B站","知乎"],
        "allDomains": ALL_DOMAINS,
    }, timeout=300)
    r.raise_for_status()
    return r.json()

OVERVIEW_487 = "【主体速览】487 在中文互联网上并非单一指称，常见的是①B站/电竞圈某位选手的编号式昵称（《第五人格》IVL 选手 Wolves_487，何添顺），②贴吧楼/数字梗，③老歌代号。直接相关的切入：- 编号昵称大盘点：487、4396 这类数字代号。相关领域的切入：- 电竞八卦·电竞圈数字代号的由来。"
BOARD = "已从各平台抓取今日实时热榜，并按所选领域（影视娱乐）筛选出以下相关热点（按平台聚合）：\n抖音 1. 冬城猎凶开播\n微博 1. 赵昭仪录节目突发哮喘\nB站 1. 某韩剧解说"
OVERVIEW_LFQ = "【主体速览】老番茄，本名张秋实，B站游戏区UP主，阴阳怪气男团成员（某幻、花少北、中国boy、LexBurner、老番茄）。直接相关的切入：- 男团考古。"
OVERVIEW_FAKER = "【主体速览】Faker，本名李相赫，韩国 T1 战队《英雄联盟》中单选手，1996年5月7日出生。直接相关的切入：- 生涯冠军盘点。"

cases = []

def case(name, msgs, domain, must_any=(), must_none=(), turn_domains=None, platforms=None):
    cases.append((name, msgs, domain, must_any, must_none, turn_domains, platforms))

# 1. 487 → 电竞的（速览后残句 = 选定含义，必须出电竞选手资料，禁止热榜）
case("1-速览后残句选含义",
     [{"role":"user","content":"487"},
      {"role":"assistant","content":OVERVIEW_487},
      {"role":"user","content":"电竞的"}],
     "影视娱乐",
     must_any=["487","何添顺","第五人格","Wolves","IVL"],
     must_none=["已从各平台","冬城猎凶","赵昭仪"])

# 2. 热榜后 → 电竞的（换领域重抓）
case("2-热榜后残句换领域",
     [{"role":"user","content":"帮我抓取今日热点"},
      {"role":"assistant","content":BOARD},
      {"role":"user","content":"电竞的"}],
     "影视娱乐",
     must_any=["【电竞】","电竞"],
     must_none=["影视娱乐）筛选"],
     turn_domains=["电竞"])

# 3. 咨询句含"热点"字样也不能误判抓榜
case("3-热点词咨询句",
     [{"role":"user","content":"热点这么多，普通人该不该跟风蹭"}],
     "",
     must_none=["已从各平台","今日热点","实时热榜"])

# 4. 裸抓热点 + 锁领域
case("4-抓今日热点(锁影视)",
     [{"role":"user","content":"帮我抓取今日热点"}],
     "影视娱乐",
     must_any=["影视娱乐","热点"],
     turn_domains=["影视娱乐"])

# 5. 跨主体指称：聊老番茄时问"花少北是谁"，必须答花少北
case("5-跨主体指称",
     [{"role":"user","content":"老番茄"},
      {"role":"assistant","content":OVERVIEW_LFQ},
      {"role":"user","content":"花少北是谁"}],
     "",
     must_any=["花少北"],
     must_none=[])

# 6. 村超咨询（chat+subject 预取）
case("6-村超值得做吗",
     [{"role":"user","content":"村超值得做内容吗"}],
     "",
     must_any=["村超"],
     must_none=["已从各平台抓取"])

# 7. 任务轮：写稿不弹速览
case("7-写口播稿任务",
     [{"role":"user","content":"用老番茄男团考古的角度写一段口播稿"}],
     "",
     must_none=["【主体速览】","直接相关的切入"])

# 8. 代词追问（followup，subject 在历史里）
case("8-代词追问",
     [{"role":"user","content":"Faker"},
      {"role":"assistant","content":OVERVIEW_FAKER},
      {"role":"user","content":"他今年多大了"}],
     "",
     must_any=["Faker","岁"],
     must_none=["已从各平台抓取"])

# 9. 清单外领域逐字抓取
case("9-清单外领域抓取",
     [{"role":"user","content":"帮我抓一下宠物和露营的热点"}],
     "",
     must_any=["宠物","露营"],
     turn_domains=None)  # 至少应识别为 hot；具体标签有则更好

# 10. 寒暄不抓榜（功能介绍里可以出现"热榜"字样，但不能是真榜单渲染）
case("10-寒暄",
     [{"role":"user","content":"你好啊"}],
     "",
     must_none=["已从各平台抓取","按平台聚合"])

# 11. 真实事故复现：未锁领域 + 热榜后"电竞的"——逐字闸必须拦住近义词等价
case("11-无锁定+电竞残句(防等价)",
     [{"role":"user","content":"帮我抓取今日热点"},
      {"role":"assistant","content":BOARD.replace("影视娱乐","全量")},
      {"role":"user","content":"电竞的"}],
     "",
     must_any=["【电竞】"],
     must_none=["【影视娱乐】"],
     turn_domains=["电竞"])

fails = 0
for name, msgs, domain, must_any, must_none, td, plats in cases:
    t0 = time.time()
    try:
        j = chat(msgs, domain, plats)
    except Exception as e:
        print(f"[FAIL] {name}: 请求异常 {e}")
        fails += 1
        continue
    c = j.get("content", "")
    got_td = j.get("turnDomains")
    miss_any = [w for w in must_any if w not in c]
    hit_none = [w for w in must_none if w in c]
    td_ok = True
    if td is not None and got_td != td:
        td_ok = False
    ok = not miss_any and not hit_none and td_ok
    fails += 0 if ok else 1
    print(f"[{'PASS' if ok else 'FAIL'}] {name} ({time.time()-t0:.0f}s) turnDomains={got_td}")
    if miss_any: print(f"   缺少应含: {miss_any}")
    if hit_none: print(f"   命中禁忌: {hit_none}")
    if not td_ok: print(f"   turnDomains 应为 {td}")
    if not ok: print("   头200:", c[:200].replace("\n"," "))

print(f"\n==== {len(cases)-fails}/{len(cases)} PASS ====")
sys.exit(1 if fails else 0)
