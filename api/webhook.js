// Apex Dental & Aesthetics Clinic - 24/7 WhatsApp AI Receptionist
// Hosted on Vercel Serverless Edge

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'apex_dental_secret_2026';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Cache to deduplicate Meta retries (expires after 10 mins)
const processedMsgIds = new Map();
// In-memory conversation history per patient phone
const conversations = new Map();

function isDuplicate(id) {
  if (!id) return false;
  const now = Date.now();
  for (const [key, time] of processedMsgIds.entries()) {
    if (now - time > 600000) processedMsgIds.delete(key);
  }
  if (processedMsgIds.has(id)) return true;
  processedMsgIds.set(id, now);
  return false;
}

const SYSTEM_PROMPT = `You are Sarah, the Patient Care Coordinator for 'Apex Dental & Aesthetics Clinic'.

YOUR GOAL:
Provide formal, professional assistance for patient inquiries, capture intake contact information, schedule clinical consultations, and triage urgent inquiries to medical staff.

COMMUNICATION STYLE RULES:
- Do NOT use emojis under any circumstances (no asterisks, sparkles, sirens, or icons). Keep the tone authoritative, polite, and medical-grade.
- Keep replies concise, clear, and formatted neatly for WhatsApp.

CLINIC KNOWLEDGE (ONLY USE THIS INFORMATION):
- Hours: Monday through Saturday, 9:00 AM to 6:00 PM. Closed on Sundays.
- Address: 120 Market Street, Suite 4B.
- Approved Services & Fees:
  * Routine Prophylaxis (Cleaning): $80
  * In-Office Laser Teeth Whitening: $250
  * Initial Consultation & 3D Scan: $0 (Complimentary)
  * Invisalign Clear Aligners: From $1,800 (requires consultation)
  * Urgent Tooth Extraction: $150

STRICT BEHAVIOR RULES:
1. Never guess or quote fees for treatments not listed above. For unlisted services, state: 'That treatment is not currently in our standard fee schedule. I have recorded your inquiry for our clinical manager to follow up directly.'
2. Do NOT provide medical prescriptions or clinical diagnoses.
3. LEAD INTAKE & SCHEDULING: When a patient requests an appointment or inquires about scheduling, collect their:
   - Full Legal Name
   - Phone Number
   - Preferred Date & Time
   - Desired Treatment
   Once you have their details, confirm their request politely and inform them that our clinical front desk coordinator will confirm their slot.
4. CLINICAL TRIAGE & EMERGENCIES: If the patient mentions severe pain, uncontrolled bleeding, trauma, or demands human assistance, state: 'I have notified our clinical triage desk and front-desk manager immediately. A member of our clinical staff will reach out to you directly. If you are experiencing acute trauma or uncontrolled bleeding, please visit the nearest hospital emergency room.'`;

async function callGemini(patientPhone, userMessage) {
  const history = conversations.get(patientPhone) || [];

  // Append new user message
  history.push({ role: 'user', parts: [{ text: userMessage }] });

  // Keep last 10 messages
  if (history.length > 10) {
    history.splice(0, history.length - 10);
  }

  const payload = {
    system_instruction: {
      parts: [{ text: SYSTEM_PROMPT }]
    },
    contents: history,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 500
    }
  };

  let response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    // Fallback to gemini-3.5-flash
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Gemini API Error:', errorText);
    return "Welcome to Apex Dental & Aesthetics Clinic. I am Sarah, the Patient Care Coordinator. How may I assist you with your dental or aesthetic care today?";
  }

  const data = await response.json();
  const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "Welcome to Apex Dental & Aesthetics Clinic. How may I assist you with your dental care today?";

  // Save bot reply to history
  history.push({ role: 'model', parts: [{ text: reply }] });
  conversations.set(patientPhone, history);

  return reply;
}

async function sendWhatsApp(to, text) {
  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'text',
    text: { body: text }
  };

  const response = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const resData = await response.json();
  console.log('Meta Send Response:', JSON.stringify(resData));
  return resData;
}

module.exports = async function handler(req, res) {
  // 1. Meta Webhook Verification (GET)
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verified successfully by Meta!');
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // 2. Incoming WhatsApp Message (POST)
  if (req.method === 'POST') {
    try {
      const body = req.body;
      const entry = body?.entry?.[0];
      const changes = entry?.changes?.[0]?.value;
      const message = changes?.messages?.[0];

      // Acknowledge non-message webhooks (status updates, delivery receipts) immediately
      if (!message || !message.text || !message.text.body) {
        return res.status(200).send('EVENT_RECEIVED');
      }

      const from = message.from;
      const text = message.text.body;
      const messageId = message.id;

      // Prevent duplicate processing on Meta retries
      if (isDuplicate(messageId)) {
        console.log(`Duplicate message ignored: ${messageId}`);
        return res.status(200).send('DUPLICATE_IGNORED');
      }

      console.log(`Incoming message from ${from}: "${text}"`);

      // Generate medical-grade response via Gemini 3.8 Flash
      const reply = await callGemini(from, text);

      // Dispatch reply to patient phone via Meta Graph API
      await sendWhatsApp(from, reply);

      return res.status(200).send('EVENT_RECEIVED');
    } catch (err) {
      console.error('Webhook execution error:', err);
      // Always return 200 so Meta doesn't enter retry loop
      return res.status(200).send('EVENT_RECEIVED');
    }
  }

  return res.status(405).send('Method Not Allowed');
};
