// Render web service: 시험범위 → 10-STEP 생성 (Claude API). STEP 1~5 / 6~10 분할 생성으로 응답 잘림 최소화.
// 환경변수: ANTHROPIC_API_KEY(필수), MODEL(기본 claude-sonnet-5), ACCESS_CODE(선택), MAX_PASSAGES(기본 20), MAX_TOKENS(기본 12000)

const express = require("express");
const docx = require("docx");
const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static("public"));

const GUIDE = `당신은 학원 영어 지문 10-STEP 연습지 제작 도우미다. 아래 지침서를 반드시 지킨다.

[원문 보존] 영어 원문의 단어를 수정·삭제·축약하지 않는다. 어순·표현 그대로 사용한다. 각 STEP의 규정된 변형만 예외로 허용한다.

[제외 유형] 도표(그래프·수치) 문항과 안내문(목록·표) 문항은 제외한다. 듣기 대본, 선택지(①②③), 한글 설명 등 지문이 아닌 텍스트도 제외한다. 문장으로 이루어진 영어 독해 지문만 대상으로 한다.

[필드 정의]
- num: 지문 번호(있으면), type: 유형(글의 목적/심경/어법/주제 등).
- eng: 지문을 문장 단위로 나눈 영어 원문 배열(원문 그대로).
- kor: 각 문장의 자연스러운 우리말 해석 배열(eng와 같은 길이·순서).
- s3: 각 문장에서 중요 명사·형용사 위주로 여러 개를 ______ 로 바꾼 배열(어순·나머지 단어 그대로).
- s5: 각 문장에서 '동사만' 원형으로 바꿔 ( ) 안에 넣은 배열. 나머지 단어는 그대로.
- s6: 각 문장에 어법/어휘 보기 [ A / B ] 를 삽입한 배열. 정답이 원문 단어가 되게 하고, 문법 포인트를 우선 출제.
- s7: 지문 전체를 한 문단으로 이어 쓰되, 어법 오류를 '정확히 3군데'만 삽입한 문자열.
- s9: 지문을 3개 내외의 의미 덩어리(문단)로 나눈 배열(원문 그대로).
- s10: 각 문장 영작용 제시어(핵심 단어 1~3개) 배열. eng와 같은 길이.

항상 설명 없이 JSON만 출력한다(코드펜스 금지).`;

function sendClaude(payload) {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(payload)
  });
}

// 지문에서 단어를 고르는 기계적인 작업이라 '생각(thinking)'이 필요 없다.
// 켜 두면 생각 토큰까지 출력 요금으로 청구되므로(측정 시 출력의 약 80%) 기본은 끔.
// 끈 설정을 거부하는 모델로 바꿀 때를 대비해, 400이 오면 한 번은 그 설정 없이 재시도한다.
// 다시 켜려면 환경변수 THINKING=on.
async function callClaude(userMsg, sys) {
  const model = process.env.MODEL || "claude-sonnet-5";
  const maxTok = parseInt(process.env.MAX_TOKENS || "12000", 10);
  const payload = { model: model, max_tokens: maxTok, system: sys || GUIDE, messages: [{ role: "user", content: userMsg }] };
  const thinkingOff = (process.env.THINKING || "off").toLowerCase() !== "on";
  if (thinkingOff) {
    payload.thinking = { type: "disabled" };
    payload.output_config = { effort: "low" };
  }
  let resp = await sendClaude(payload);
  if (!resp.ok && thinkingOff && resp.status === 400) {
    let body = "";
    try { body = await resp.clone().text(); } catch (e) { body = ""; }
    if (/thinking|output_config|effort/i.test(body)) {
      console.warn("이 모델은 thinking/effort 설정을 거부함 — 설정 없이 재시도:", body.slice(0, 200));
      delete payload.thinking; delete payload.output_config;
      resp = await sendClaude(payload);
    }
  }
  return resp;
}

// 지문 찾기 전용 — 본문을 다시 받아 적지 않고 앞뒤 몇 단어(앵커)만 받는다(출력 토큰 절약).
const SCAN_SYS = `너는 영어 시험범위 텍스트에서 '영어 독해 지문'만 찾아내는 도구다. 도표(그래프·수치) 문항, 안내문(목록·표), 듣기 대본, 선택지(①②③), 한글 설명은 지문이 아니다. 문장으로 이루어진 영어 독해 지문만 고른다. 항상 설명 없이 JSON만 출력한다(코드펜스 금지).`;

// 연습지 데이터 전용 — 원문을 다시 쓰지 않고 '바꿀 단어'만 받는다(출력 토큰 절약 + 원문 보존).
const DETAIL_SYS = `너는 영어 지문으로 학원 연습지를 만드는 도구다.

[절대 규칙] 영어 원문을 다시 쓰지 않는다. 바꿀 '단어'만 고른다. 고른 단어는 반드시 그 문장에 원문 그대로 등장하는 형태여야 한다(대소문자·어미까지 동일). 문장에 없는 단어를 지어내면 안 된다.

항상 설명 없이 JSON만 출력한다(코드펜스 금지).`;

app.post("/api/generate", async (req, res) => {
  const body = req.body || {};
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다. Render 환경변수를 확인하세요." });
  if (process.env.ACCESS_CODE && (body.accessCode || "") !== process.env.ACCESS_CODE) return res.status(401).json({ error: "접근 코드가 올바르지 않습니다." });

  const grammar = (body.grammar || "").trim();
  const maxP = parseInt(process.env.MAX_PASSAGES || "20", 10);
  const part = body.part || "all";
  let userMsg, sys = GUIDE;

  if (part === "scan") {
    const text = (body.text || "").trim();
    if (!text) return res.status(400).json({ error: "시험범위 텍스트가 비어 있습니다." });
    sys = SCAN_SYS;
    userMsg =
      "아래 텍스트에서 영어 독해 지문을 빠짐없이 찾아라(최대 " + maxP + "개). 지문 본문은 옮겨 적지 말고, 지문마다 다음 네 가지만 만든다.\n" +
      "- num: 문항 번호(없으면 빈 문자열)\n" +
      "- type: 유형(글의 목적/주제/어법 등, 모르면 빈 문자열)\n" +
      "- head: 그 지문의 '첫 6단어'를 원문 그대로\n" +
      "- tail: 그 지문의 '마지막 6단어'를 원문 그대로(문장부호 포함)\n\n" +
      "[텍스트]\n" + text + "\n\n" +
      'JSON만 출력: {"passages":[{"num":"","type":"","head":"","tail":""}]}';
  } else if (part === "recover") {
    const text = (body.text || "").trim();
    const misses = Array.isArray(body.misses) ? body.misses.slice(0, maxP) : [];
    if (!text || !misses.length) return res.status(400).json({ error: "원문을 확인할 지문 정보가 없습니다." });
    sys = SCAN_SYS;
    userMsg =
      "아래 텍스트에서 다음 지문들의 본문을 찾아 문장 단위로 나눠라. 원문 그대로 옮기고 수정·요약하지 않는다.\n\n" +
      "[찾을 지문]\n" + JSON.stringify(misses) + "\n\n" +
      "[텍스트]\n" + text + "\n\n" +
      'JSON만 출력: {"passages":[{"num":"","type":"","eng":[]}]}';
  } else if (part === "detail") {
    const one = body.passage && Array.isArray(body.passage.eng) && body.passage.eng.length ? body.passage : null;
    if (!one) return res.status(400).json({ error: "지문 데이터가 없습니다." });
    const n = one.eng.length;
    const numbered = one.eng.map((e, i) => (i + 1) + ". " + e).join("\n");
    sys = DETAIL_SYS;
    userMsg =
      "[지문] (문장 1~" + n + ")\n" + numbered + "\n\n" +
      (grammar ? ("[문법 포인트 — choices·errors에 우선 반영]\n" + grammar + "\n\n") : "") +
      "다음을 만든다. kor·blanks·verbs·choices·s10은 길이가 정확히 " + n + "이어야 한다.\n" +
      "- kor: 각 문장의 자연스러운 우리말 해석\n" +
      "- blanks: 문장마다 빈칸으로 만들 중요 명사·형용사 1~3개를 문자열 배열로. 즉 [[\"단어\",\"단어\"], ...] 꼴로 " + n + "개. 없으면 []\n" +
      "- verbs: 문장마다 동사 한 개를 [문장에 쓰인 형태, 동사원형] 쌍으로. 즉 [[\"쓰인형태\",\"원형\"], ...] 꼴로 " + n + "개. 없으면 []\n" +
      "- choices: 문장마다 어법·어휘 포인트 한 개를 [문장에 쓰인 형태(정답), 그럴듯한 오답] 쌍으로. 즉 [[\"정답\",\"오답\"], ...] 꼴로 " + n + "개. 정답은 그 문장에 있는 그대로여야 한다\n" +
      "- errors: 지문 전체에서 어법 오류로 바꿀 3곳을 [원문 단어, 틀린 형태] 쌍 3개로(서로 다른 문장에서)\n" +
      "- chunks: 의미 덩어리 3개 내외를 [시작 문장번호, 끝 문장번호]로. 1부터 " + n + "까지 빠짐없이 이어져야 한다\n" +
      "- s10: 각 문장 영작용 제시어(핵심 단어 1~3개를 쉼표로 이은 한 문자열)\n\n" +
      'JSON만 출력: {"passages":[{"kor":[],"blanks":[],"verbs":[],"choices":[],"errors":[],"chunks":[],"s10":[]}]}';
  } else if (part === "part2") {
    const passages = Array.isArray(body.passages) ? body.passages : [];
    if (!passages.length) return res.status(400).json({ error: "part2 요청에 지문 데이터가 없습니다." });
    const slim = passages.map((p) => ({ num: p.num, type: p.type, eng: p.eng, kor: p.kor }));
    userMsg =
      "아래 지문들에 대해 STEP 6~10용 데이터만 만든다: s6, s7, s9, s10. 각 지문의 eng 문장 순서를 그대로 사용하고 s6/s10의 길이를 eng 문장 수와 정확히 맞춘다.\n\n" +
      "[지문들]\n" + JSON.stringify(slim) + "\n\n" +
      (grammar ? ("[문법 포인트 — STEP 6·7 우선 반영]\n" + grammar + "\n\n") : "") +
      '입력과 같은 순서로 JSON만 출력: {"passages":[{"s6":[],"s7":"","s9":[],"s10":[]}]}';
  } else if (part === "part1") {
    const one = body.passage && Array.isArray(body.passage.eng) && body.passage.eng.length ? body.passage : null;
    if (one) {
      userMsg =
        "아래 지문 하나에 대해 STEP 1~5용 데이터만 만든다: kor, s3, s5. eng 문장 순서를 그대로 쓰고 세 배열의 길이를 eng 문장 수(" + one.eng.length + "개)와 정확히 맞춘다.\n\n" +
        "[지문]\n" + JSON.stringify({ num: one.num, type: one.type, eng: one.eng }) + "\n\n" +
        'JSON만 출력: {"passages":[{"kor":[],"s3":[],"s5":[]}]}';
    } else {
      const text = (body.text || "").trim();
      if (!text) return res.status(400).json({ error: "시험범위 텍스트가 비어 있습니다." });
      userMsg =
        "다음 텍스트에서 영어 독해 지문만 골라(최대 " + maxP + "개) STEP 1~5용 데이터만 만든다: eng, kor, s3, s5. 도표·안내문·듣기·선택지·한글 설명은 제외.\n\n" +
        "[시험범위 텍스트]\n" + text + "\n\n" +
        'JSON만 출력: {"passages":[{"num":"","type":"","eng":[],"kor":[],"s3":[],"s5":[]}]}';
    }
  } else {
    const text = (body.text || "").trim();
    if (!text) return res.status(400).json({ error: "시험범위 텍스트가 비어 있습니다." });
    userMsg =
      "다음은 시험범위에서 추출한 텍스트다. 영어 독해 지문만 골라(최대 " + maxP + "개), 각 지문마다 10-STEP 데이터를 지침서대로 만들어라. 도표·안내문·듣기·선택지·한글 설명은 제외한다.\n\n" +
      "[시험범위 텍스트]\n" + text + "\n\n" +
      (grammar ? ("[문법 포인트]\n" + grammar + "\n\n") : "") + "JSON만 출력하라.";
  }

  try {
    const resp = await callClaude(userMsg, sys);
    const data = await resp.json();
    if (!resp.ok) return res.status(502).json({ error: "Claude API 오류: " + (data && data.error ? data.error.message : resp.status) });
    let out = "";
    if (data.content && data.content.length) out = data.content.map((c) => c.text || "").join("");
    const meta = {
      model: data.model || process.env.MODEL || "claude-sonnet-5",
      usage: { input: (data.usage && data.usage.input_tokens) || 0, output: (data.usage && data.usage.output_tokens) || 0 }
    };
    const parsed = extractPayload(out);
    if (part === "scan" && parsed && Array.isArray(parsed.passages) && !parsed.passages.length) return res.json(Object.assign({ passages: [] }, meta));
    if (!parsed || !parsed.passages || !parsed.passages.length) {
      console.error("PARSE FAIL part=", part, " stop_reason=", data.stop_reason, " raw(first 1200):\n", out.slice(0, 1200));
      return res.status(502).json({ error: "AI 응답을 해석하지 못했습니다.", stop_reason: data.stop_reason || "", raw: out.slice(0, 600) });
    }
    if (data.stop_reason === "max_tokens") console.warn("part=", part, " max_tokens로 잘렸지만 완성분만 반환. passages=", parsed.passages.length);
    return res.json(Object.assign(parsed, meta));
  } catch (e) {
    return res.status(500).json({ error: "요청 실패: " + e.message });
  }
});

app.post("/api/ocr", async (req, res) => {
  const body = req.body || {};
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다." });
  if (process.env.ACCESS_CODE && (body.accessCode || "") !== process.env.ACCESS_CODE) return res.status(401).json({ error: "접근 코드가 올바르지 않습니다." });
  const images = Array.isArray(body.images) ? body.images : [];
  if (!images.length) return res.status(400).json({ error: "이미지가 없습니다." });
  const model = process.env.MODEL || "claude-sonnet-5";
  const content = images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.mediaType || "image/png", data: im.data } }));
  content.push({ type: "text", text: "이 이미지들에 담긴 텍스트를 원문 그대로 정확히 옮겨 적어라. 특히 영어 지문은 철자·구두점까지 정확하게. 여러 장이면 순서대로 이어서 적고, 필기·워터마크·페이지번호 같은 잡음은 무시한다. 설명 없이 옮긴 텍스트만 출력하라." });
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: model, max_tokens: 4000, messages: [{ role: "user", content: content }] })
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(502).json({ error: "이미지 인식 오류: " + (data && data.error ? data.error.message : resp.status) });
    let out = "";
    if (data.content && data.content.length) out = data.content.map((c) => c.text || "").join("");
    return res.json({ text: out });
  } catch (e) {
    return res.status(500).json({ error: "요청 실패: " + e.message });
  }
});

function extractPayload(t) {
  if (!t) return null;
  t = t.replace(/```json/gi, "").replace(/```/g, "");
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try {
      const o = JSON.parse(t.slice(s, e + 1));
      if (o && Array.isArray(o.passages)) return o;
      if (o && Array.isArray(o)) return { passages: o };
      if (o && (o.eng || o.s6)) return { passages: [o] };
    } catch (err) { /* fall through */ }
  }
  const arr = salvagePassages(t);
  if (arr && arr.length) return { passages: arr };
  return null;
}

function salvagePassages(t) {
  const key = t.indexOf('"passages"');
  let i = key >= 0 ? t.indexOf("[", key) : t.indexOf("[");
  if (i < 0) return null;
  i++;
  const objs = [];
  const n = t.length;
  while (i < n) {
    while (i < n && (t[i] === "," || t[i] === " " || t[i] === "\n" || t[i] === "\r" || t[i] === "\t")) i++;
    if (i >= n || t[i] === "]") break;
    if (t[i] !== "{") break;
    let depth = 0, j = i, inStr = false, esc = false;
    for (; j < n; j++) {
      const c = t[j];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
      else { if (c === '"') inStr = true; else if (c === "{") depth++; else if (c === "}") { depth--; if (depth === 0) { j++; break; } } }
    }
    if (depth !== 0) break;
    try { objs.push(JSON.parse(t.slice(i, j))); } catch (err) { break; }
    i = j;
  }
  return objs;
}

app.post("/api/docx", async (req, res) => {
  const body = req.body || {};
  if (process.env.ACCESS_CODE && (body.accessCode || "") !== process.env.ACCESS_CODE) return res.status(401).json({ error: "접근 코드가 올바르지 않습니다." });
  const passages = Array.isArray(body.passages) ? body.passages : [];
  if (!passages.length) return res.status(400).json({ error: "생성된 지문이 없습니다." });

  const { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle, ShadingType } = docx;
  const PAREN = ["(A)","(B)","(C)","(D)","(E)","(F)","(G)","(H)","(I)","(J)"];
  const S = (v) => (v == null ? "" : (typeof v === "string" ? v : (typeof v === "object" ? String(v.text || v.sentence || v.eng || v.value || "") : String(v))));
  const SA = (a) => (Array.isArray(a) ? a.map(S) : []);
  const wcount = (t) => S(t).split(/\s+/).filter((x) => x.length).length;
  const ul = (n) => { let s = ""; for (let i = 0; i < n; i++) s += "____ "; return s; };
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; };

  const kids = [];
  const title = (t) => new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120 }, children: [new TextRun({ text: t, bold: true, size: 32, color: "1A3A5C" })] });
  const small = (t) => new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: t, size: 18, color: "555555" })] });
  const phead = (t, first) => new Paragraph({ pageBreakBefore: !first, spacing: { before: 160, after: 100 }, shading: { type: ShadingType.SOLID, color: "1A3A5C" }, children: [new TextRun({ text: t, bold: true, color: "FFFFFF", size: 26 })] });
  const stitle = (t) => new Paragraph({ spacing: { before: 160, after: 70 }, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "CFDAE6" } }, children: [new TextRun({ text: t, bold: true, color: "2E6DA4", size: 24 })] });
  const line = (t) => new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: t, size: 22 })] });
  const two = (a, b) => new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: a, size: 22 }), new TextRun({ text: b, size: 22, color: "333333", break: 1 })] });
  const blank = () => new Paragraph({ spacing: { after: 140 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "BBBBBB" } }, children: [new TextRun({ text: " " })] });
  const bold = (t) => new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: t, bold: true, size: 22 })] });

  kids.push(title("10-STEP 영어 지문 연습지"));
  const hd = [];
  if (body.school || body.grade) hd.push((body.school || "") + (body.grade ? " " + body.grade : ""));
  if (body.examScope) hd.push("출제 범위 · " + body.examScope);
  if (body.grammar) hd.push("문법 · " + body.grammar);
  hd.forEach((h) => kids.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: h, bold: true, size: 20, color: "243B52" })] })));
  kids.push(small("원문은 수정·삭제·축약 없이 사용합니다. STEP 7에는 어법 오류가 삽입되어 있습니다(개수는 지문마다 제목에 표시). 정답은 없습니다."));

  passages.forEach((p, pi) => {
    const eng = SA(p.eng), kor = SA(p.kor), s3 = SA(p.s3), s5 = SA(p.s5), s6 = SA(p.s6), s10 = SA(p.s10);
    const s7 = S(p.s7), s9 = SA(p.s9);
    kids.push(phead("지문 " + S(p.num) + (S(p.type) ? " [" + S(p.type) + "]" : ""), pi === 0));
    kids.push(stitle("STEP 1. 영어 + 해석"));
    eng.forEach((e, i) => kids.push(two((i + 1) + ". " + e, kor[i] || "")));
    kids.push(stitle("STEP 2. 영어 원문 → 해석 쓰기"));
    eng.forEach((e, i) => { kids.push(line((i + 1) + ". " + e)); kids.push(blank()); });
    kids.push(stitle("STEP 3. 해석 제시 → 빈칸 채우기"));
    eng.forEach((e, i) => kids.push(two((i + 1) + ". " + (kor[i] || ""), s3[i] || e)));
    kids.push(stitle("STEP 4. 영어 원문 → 해석 쓰기"));
    eng.forEach((e, i) => { kids.push(line((i + 1) + ". " + e)); kids.push(blank()); });
    kids.push(stitle("STEP 5. 동사를 원형으로 → 형태 고치기"));
    eng.forEach((e, i) => { kids.push(line((i + 1) + ". " + (s5[i] || e))); kids.push(blank()); });
    kids.push(stitle("STEP 6. 어법·어휘 보기 고르기"));
    eng.forEach((e, i) => kids.push(line((i + 1) + ". " + (s6[i] || e))));
    kids.push(stitle("STEP 7. 어법상 틀린 곳 " + ((parseInt(p.s7n, 10) || 3)) + "군데 찾아 고치기"));
    kids.push(line(s7 || eng.join(" ")));
    kids.push(line("① ________ → ________   ② ________ → ________   ③ ________ → ________"));
    if (eng.length >= 3) {
      kids.push(stitle("STEP 8. 첫 문장에 이어질 문장 순서 배열"));
      kids.push(bold("[주어진 문장] " + eng[0]));
      const rest = shuffle(eng.slice(1));
      rest.forEach((e, i) => kids.push(line(PAREN[i] + " " + e)));
      kids.push(bold("순서: " + rest.map(() => "____").join(" → ")));
    }
    let chunks = s9.slice();
    if (chunks.length < 2) { const g = Math.max(1, Math.ceil(eng.length / 3)); chunks = []; for (let i = 0; i < eng.length; i += g) chunks.push(eng.slice(i, i + g).join(" ")); }
    if (chunks.length >= 2) {
      kids.push(stitle("STEP 9. 문단 순서 배열"));
      const sh = shuffle(chunks);
      sh.forEach((c, i) => kids.push(line(PAREN[i] + " " + c)));
      kids.push(bold("순서: " + sh.map(() => "____").join(" → ")));
    }
    kids.push(stitle("STEP 10. 영작 (해석 + 제시어, 빈칸 수 = 단어 수)"));
    eng.forEach((e, i) => {
      const n = wcount(e);
      kids.push(line((i + 1) + ". " + (kor[i] || "") + " (" + n + " 단어)"));
      kids.push(line(ul(n)));
      if (s10[i]) kids.push(new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: "제시어: " + s10[i], size: 20, color: "B5532A" })] }));
    });
  });

  try {
    const doc = new Document({ sections: [{ properties: { page: { margin: { top: 850, bottom: 850, left: 800, right: 800 } } }, children: kids }] });
    const buf = await Packer.toBuffer(doc);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", "attachment; filename=10step.docx");
    return res.send(buf);
  } catch (e) {
    return res.status(500).json({ error: "Word 생성 실패: " + e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("10-STEP generator running on " + PORT + " · MODEL=" + (process.env.MODEL || "claude-sonnet-5(기본)") + " · MAX_PASSAGES=" + (process.env.MAX_PASSAGES || "20(기본)") + " · MAX_TOKENS=" + (process.env.MAX_TOKENS || "12000(기본)")));
