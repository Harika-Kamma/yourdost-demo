// Serverless function. Keeps the API key secret on the server.
// Needs ONE env var in Netlify: GEMINI_API_KEY (or ANTHROPIC_API_KEY).
// Open this function's URL in a browser (GET) to see a self-test.
const SYSTEM = `You are "Next Step Navigator", a warm, brief assistant inside YourDOST, an employee wellbeing platform in India.
You are NOT a therapist. You never diagnose and never give treatment advice. Your only job: understand how the person feels and point them to ONE best next step.
Services (use these exact keys): counseling (1:1 online counseling), selfhelp (self-help articles/audio), assess (5-min stress/burnout assessment), group (group workshops/peer circles), sleep (sleep & relaxation exercises).
Rules:
- Ask at most 2 short, kind follow-up questions (one per turn). After that, recommend.
- If the person mentions self-harm, suicide, or not wanting to live, set "crisis": true.
- Plain, friendly language. Replies under 50 words. No medical claims.
- Reply ONLY with JSON: {"reply":string,"ready":boolean,"crisis":boolean,"primary":key|null,"alternatives":[key,key]|null,"why":string|null,"confidence":"High"|"Medium"|"Low"|null}
- "why" is 1-2 simple sentences explaining the recommendation using the person's own words. Use "Low" confidence if unsure.`;

const KEYS = ["counseling","selfhelp","assess","group","sleep"];
const MODELS = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : ["gemini-2.5-flash","gemini-flash-latest","gemini-2.5-flash-lite","gemini-flash-lite-latest","gemini-2.0-flash"];
const json = (code, obj) => ({ statusCode: code, headers: {"Content-Type":"application/json"}, body: JSON.stringify(obj, null, 2) });
const clean = (s) => String(s).replace(process.env.GEMINI_API_KEY || "\u0000", "***").replace(process.env.ANTHROPIC_API_KEY || "\u0000", "***").slice(0, 300);

async function callGemini(msgs) {
  const key = process.env.GEMINI_API_KEY;
  let last = "no attempt";
  const t0 = Date.now();
  for (const model of MODELS) {
    if (Date.now() - t0 > 7500) break; // stay inside Netlify's ~10s function limit
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: "POST", headers: {"content-type":"application/json"},
      body: JSON.stringify({
        systemInstruction: {parts:[{text: SYSTEM}]},
        contents: msgs.map(m => ({role: m.role === "assistant" ? "model" : "user", parts:[{text:m.content}]})),
        generationConfig: {responseMimeType: "application/json", temperature: 0.4}
      })
    });
    if (r.ok) {
      const d = await r.json();
      const t = d && d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts && d.candidates[0].content.parts[0] && d.candidates[0].content.parts[0].text;
      if (t) return t;
      last = "empty reply from " + model; continue;
    }
    last = `gemini ${r.status} on ${model}: ${clean(await r.text())}`;
    if ([400, 401, 403].includes(r.status)) break; // bad key or request: other models will not help
    // 404 = retired model, 429/500/503 = busy: try the next model
  }
  throw new Error(last);
}

async function callAnthropic(msgs) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {"content-type":"application/json","x-api-key":process.env.ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01"},
    body: JSON.stringify({model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5", max_tokens: 500, system: SYSTEM, messages: msgs})
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${clean(await r.text())}`);
  return (await r.json()).content[0].text;
}

async function ask(msgs) {
  if (process.env.ANTHROPIC_API_KEY) return callAnthropic(msgs);
  if (process.env.GEMINI_API_KEY) return callGemini(msgs);
  throw new Error("no API key found: add GEMINI_API_KEY in Netlify environment variables (scope: Functions) and redeploy");
}

exports.handler = async (event) => {
  // Self-test: open the function URL in a browser
  if (event.httpMethod === "GET") {
    const out = {function: "deployed", geminiKeyPresent: !!process.env.GEMINI_API_KEY, anthropicKeyPresent: !!process.env.ANTHROPIC_API_KEY, modelsTried: MODELS};
    try { const t = await ask([{role:"user", content:"I feel stressed at work."}]); out.aiCall = "SUCCESS"; out.sample = clean(t); }
    catch (e) { out.aiCall = "FAILED"; out.reason = clean(e.message); }
    return json(200, out);
  }
  if (event.httpMethod !== "POST") return json(405, {error:"POST only"});
  let msgs;
  try { msgs = JSON.parse(event.body).messages; } catch (e) { return json(400, {error:"bad request"}); }
  msgs = (msgs || []).slice(-12).map(m => ({role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 800)}));
  if (!msgs.length) return json(400, {error:"no messages"});
  try {
    const text = await ask(msgs);
    const d = JSON.parse(text.replace(/```json|```/g, "").trim());
    const ok = k => KEYS.includes(k);
    const out = {reply: String(d.reply || "").slice(0, 400), crisis: !!d.crisis, ready: !!d.ready && ok(d.primary)};
    if (out.ready) {
      out.primary = d.primary;
      out.alternatives = (d.alternatives || []).filter(ok).filter(k => k !== d.primary).slice(0, 2);
      out.why = String(d.why || "").slice(0, 300);
      out.confidence = ["High","Medium","Low"].includes(d.confidence) ? d.confidence : "Medium";
    }
    return json(200, out); // nothing is logged or stored
  } catch (e) {
    return json(502, {error: clean(e.message)});
  }
};
