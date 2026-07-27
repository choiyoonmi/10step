// Render web service: 시험범위 텍스트 → 여러 지문 10-STEP 생성 (Claude API)
// 환경변수:
//   ANTHROPIC_API_KEY (필수)
//   MODEL             (선택) 기본 "claude-sonnet-5"
//   ACCESS_CODE       (선택) 설정 시 이 코드를 아는 사람만 사용
//   MAX_PASSAGES      (선택) 한 번에 생성할 최대 지문 수, 기본 6

const express = require("express");
const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static("public"));

const GUIDE = `당신은 학원 영어 지문 10-STEP 연습지 제작 도우미다. 아래 지침서를 반드시 지킨다.

[원문 보존] 영어 원문의 단어를 수정·삭제·축약하지 않는다. 어순·표현 그대로 사용한다. 각 STEP의 규정된 변형만 예외로 허용한다.

[제외 유형] 도표(그래프·수치) 문항과 안내문(목록·표) 문항은 지문형이 아니므로 제외한다. 듣기 대본, 문항 선택지(①②③), 한글 설명 등 지문이 아닌 텍스트도 제외한다. 문장으로 이루어진 영어 독해 지문만 대상으로 한다.

[각 지문마다 만드는 데이터]
- num: 지문 번호(있으면), type: 유형(예: 글의 목적, 심경, 어법, 주제 등).
- eng: 지문을 문장 단위로 나눈 영어 원문 배열(원문 그대로).
- kor: 각 문장의 자연스러운 우리말 해석 배열(eng와 같은 길이·순서).
- s3: 각 문장에서 중요 명사·형용사 위주로 여러 개를 ______ 로 바꾼 배열(어순·나머지 단어 그대로).
- s5: 각 문장에서 '동사만' 원형으로 바꿔 ( ) 안에 넣은 배열. 나머지 단어는 그대로.
- s6: 각 문장에 어법/어휘 보기 [ A / B ] 를 삽입한 배열. 정답이 원문 단어가 되게 하고, 가능하면 '문법 포인트'에 나온 항목을 우선 출제.
- s7: 지문 전체를 한 문단으로 이어 쓰되, 어법 오류를 '정확히 3군데'만 삽입한 문자열. 문법 포인트 위주로 오류를 만든다.
- s9: 지문을 3개 내외의 의미 덩어리(문단)로 나눈 배열(원문 그대로).
- s10: 각 문장 영작용 제시어(핵심 단어 1~3개) 배열. eng와 같은 길이.

[출력] 설명 없이 아래 JSON만 출력한다(코드펜스 금지):
{"passages":[{"num":"","type":"","eng":[],"kor":[],"s3":[],"s5":[],"s6":[],"s7":"","s9":[],"s10":[]}]}`;

app.post("/api/generate", async (req, res) => {
  const body = req.body || {};
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다. Render 환경변수를 확인하세요." });

  if (process.env.ACCESS_CODE && (body.accessCode || "") !== process.env.ACCESS_CODE) {
    return res.status(401).json({ error: "접근 코드가 올바르지 않습니다." });
  }

  const text = (body.text || "").trim();
  if (!text) return res.status(400).json({ error: "시험범위 텍스트가 비어 있습니다." });
  const grammar = (body.grammar || "").trim();
  const maxP = parseInt(process.env.MAX_PASSAGES || "3", 10);

  const userMsg =
    "다음은 시험범위에서 추출한 텍스트다. 영어 독해 지문만 골라(최대 " + maxP + "개), 각 지문마다 10-STEP 데이터를 지침서대로 만들어라. 도표·안내문·듣기·선택지·한글 설명은 제외한다.\n\n" +
    "[시험범위 텍스트]\n" + text + "\n\n" +
    (grammar ? ("[문법 포인트 — STEP 6·7 우선 반영]\n" + grammar + "\n\n") : "") +
    "JSON만 출력하라.";

  const model = process.env.MODEL || "claude-sonnet-5";
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: model, max_tokens: 8000, system: GUIDE, messages: [{ role: "user", content: userMsg }] })
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(502).json({ error: "Claude API 오류: " + (data && data.error ? data.error.message : resp.status) });
    let out = "";
    if (data.content && data.content.length) out = data.content.map((c) => c.text || "").join("");
    const parsed = extractPayload(out);
    if (!parsed || !parsed.passages || !parsed.passages.length) {
      console.error("PARSE FAIL. stop_reason=", data.stop_reason, " raw(first 1200):\n", out.slice(0, 1200));
      return res.status(502).json({ error: "AI 응답을 해석하지 못했습니다.", stop_reason: data.stop_reason || "", raw: out.slice(0, 600) });
    }
    if (data.stop_reason === "max_tokens") console.warn("응답이 max_tokens로 잘렸지만 완성된 지문만 살려서 반환함. passages=", parsed.passages.length);
    return res.json(parsed);
  } catch (e) {
    return res.status(500).json({ error: "요청 실패: " + e.message });
  }
});

function extractPayload(t) {
  if (!t) return null;
  t = t.replace(/```json/gi, "").replace(/```/g, "");
  // 1) 통째로 파싱 시도
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try {
      const o = JSON.parse(t.slice(s, e + 1));
      if (o && Array.isArray(o.passages)) return o;
      if (o && Array.isArray(o)) return { passages: o };
      if (o && o.eng) return { passages: [o] };
    } catch (err) { /* fall through */ }
  }
  // 2) 잘린 응답 복구: passages 배열에서 완성된 객체만 수집
  const arr = salvagePassages(t);
  if (arr && arr.length) return { passages: arr };
  return null;
}

function salvagePassages(t) {
  let key = t.indexOf('"passages"');
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
    if (depth !== 0) break; // 마지막 객체가 잘림 -> 여기서 중단
    try { objs.push(JSON.parse(t.slice(i, j))); } catch (err) { break; }
    i = j;
  }
  return objs;
}

app.post("/api/ocr", async (req, res) => {
  const body = req.body || {};
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다." });
  if (process.env.ACCESS_CODE && (body.accessCode || "") !== process.env.ACCESS_CODE) {
    return res.status(401).json({ error: "접근 코드가 올바르지 않습니다." });
  }
  const images = Array.isArray(body.images) ? body.images : [];
  if (!images.length) return res.status(400).json({ error: "이미지가 없습니다." });
  const model = process.env.MODEL || "claude-sonnet-5";
  const content = images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.mediaType || "image/png", data: im.data } }));
  content.push({ type: "text", text: "이 이미지들에 담긴 텍스트를 원문 그대로 정확히 옮겨 적어라. 특히 영어 지문은 철자·구두점까지 정확하게. 여러 장이면 순서대로 이어서 적고, 필기·워터마크·페이지번호 같은 잡음은 무시한다. 설명 없이 옮긴 텍스트만 출력하라." });
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("10-STEP generator running on " + PORT));
