// Serverless function: keeps your API key secret on the server.
// Set ONE of these in Netlify > Site configuration > Environment variables:
//   GEMINI_API_KEY (free tier at aistudio.google.com)  or  ANTHROPIC_API_KEY
const SYSTEM = `You are "Next Step Navigator", a warm, brief assistant inside YourDOST, an employee wellbeing platform in India.
You are NOT a therapist. You never diagnose and never give treatment advice. Your only job: understand how the person feels and point them to ONE best next step.
Services (use these exact keys): counseling (1:1 online counseling), selfhelp (self-help articles/audio), assess (5-min stress/burnout assessment), group (group workshops/peer circles), sleep (sleep & relaxation exercises).
Rules:
- Ask at most 2 short, kind follow-up questions (one per turn). After that, recommend.
- If the person mentions self-harm, suicide, or not wanting to live, set "crisis": true and nothing else matters.
- Plain, friendly language. Replies under 50 words. No medical claims.
- Reply ONLY with JSON: {"reply":string,"ready":boolean,"crisis":boolean,"primary":key|null,"alternatives":[key,key]|null,"why":string|null,"confidence":"High"|"Medium"|"Low"|null}
- "why" is 1-2 simple sentences explaining the recommendation using the person's own words. Use "Low" confidence if unsure.`;

const KEYS = ["counseling","selfhelp","assess","group","sleep"];
const json = (code, obj) => ({ statusCode: code, headers: {"Content-Type":"application/json"}, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, {error:"POST only"});
  let msgs;
  try { msgs = JSON.parse(event.body).messages; } catch { return json(400, {error:"bad request"}); }
  msgs = (msgs || []).slice(-12).map(m => ({role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 800)}));
  if (!msgs.length) return json(400, {error:"no messages"});
  try {
    let text;
    if (process.env.ANTHROPIC_API_KEY) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {"content-type":"application/json","x-api-key":process.env.ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01"},
        body: JSON.stringify({model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5", max_tokens: 500, system: SYSTEM, messages: msgs})
      });
      if (!r.ok) throw new Error("anthropic " + r.status);
      text = (await r.json()).content[0].text;
    } else if (process.env.GEMINI_API_KEY) {
      const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: "POST", headers: {"content-type":"application/json"},
        body: JSON.stringify({
          systemInstruction: {parts:[{text: SYSTEM}]},
          contents: msgs.map(m => ({role: m.role === "assistant" ? "model" : "user", parts:[{text:m.content}]})),
          generationConfig: {responseMimeType: "application/json", temperature: 0.4}
        })
      });
      if (!r.ok) throw new Error("gemini " + r.status);
      text = (await r.json()).candidates[0].content.parts[0].text;
    } else return json(500, {error:"no API key set"});

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
    return json(502, {error:"AI unavailable"}); // client falls back to the offline engine
  }
};
