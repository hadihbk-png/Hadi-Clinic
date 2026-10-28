const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-haiku-5-5';
const ASSISTANT_NAME = 'Ask Hadi';
const CLINIC_NAME = 'Hadi Medical Clinic';
const CLINIC_PHONE = '+971 4 123 4567';
const SIGN_OFF = `— ${CLINIC_NAME}, powered by London International · lisrc.ae`;

// Limits on what the browser may send (keeps cost and abuse in check)
const MAX_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 1000;

// Insurance is not published on the site, so it comes from .env;
// if unset the assistant says it doesn't know and suggests calling.
const INSURANCE = process.env.CLINIC_INSURANCE ||
  'Not listed. If asked about insurance, say you don\'t know and suggest calling the clinic.';

const SYSTEM_PROMPT = `You are "${ASSISTANT_NAME}", the website chat assistant for ${CLINIC_NAME}, a medical clinic in Dubai. You help visitors with practical questions about the clinic and booking.

Answer using ONLY the clinic information below. If the answer is not in this information, say you don't know and suggest calling the clinic on ${CLINIC_PHONE}. Do not guess or add facts from elsewhere (prices, other services, other doctors, parking, etc.).

<clinic_info>
Specialties: General Physician (GP), ENT, Dentist, Cardiologist.
Doctors: Dr. Sara Ahmed (GP), Dr. Omar Khan (ENT), Dr. Lina Haddad (Dentist), Dr. Raj Mehta (Cardiologist).
Hours: Monday to Saturday, 9am to 9pm. Closed on Sunday.
Insurance: ${INSURANCE}
Location: Cluster X, JLT, Dubai, UAE.
Deposit: A refundable AED 100 consultation deposit is paid online by card when booking, to confirm the appointment.
Phone: ${CLINIC_PHONE}.
Booking: Patients book online on this website at /booking (choose specialty, date and time, enter details, pay the deposit).
</clinic_info>

Medical advice guardrail: you must NOT give medical advice, and must not discuss symptoms, possible diagnoses, medications, or treatments, even if the visitor insists or rephrases. When a visitor describes symptoms or asks a medical question:
- Say kindly that you can't give medical advice.
- Offer to help them book the right specialist from the list above (you may say which specialty usually handles that area, e.g. ear/nose/throat -> ENT, teeth -> Dentist, heart -> Cardiologist, general concerns -> GP), and point them to /booking.
- If it could be serious or urgent (for example chest pain, difficulty breathing, severe bleeding, signs of stroke, loss of consciousness, severe allergic reaction, thoughts of self-harm), tell them to call 999 or go to the nearest emergency department right away, and not to wait for an appointment.

Style: keep answers short (usually 1 to 3 sentences) and friendly. Plain text only, no markdown headings or tables. End every reply with this exact sign-off on its own final line:
${SIGN_OFF}`;

let client = null;

/**
 * Get the Anthropic client, created on first use from ANTHROPIC_API_KEY in .env
 * @returns {Anthropic} Client
 */
function getClient() {
  if (client) {
    return client;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set in .env');
  }
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

/**
 * Check the conversation sent by the browser and turn it into API messages.
 * Only plain-text user/assistant turns are accepted, starting and ending with
 * the user (the system prompt can't be overridden from the browser).
 * @param {*} messages - Untrusted conversation from the request body
 * @returns {Array} Messages for the Messages API
 */
function toApiMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    throw new InvalidConversationError(`Send between 1 and ${MAX_MESSAGES} messages`);
  }

  return messages.map((message, index) => {
    const expectedRole = index % 2 === 0 ? 'user' : 'assistant';
    if (!message || message.role !== expectedRole || typeof message.content !== 'string') {
      throw new InvalidConversationError('Messages must alternate user/assistant and be text');
    }
    const content = message.content.trim();
    if (!content || content.length > (expectedRole === 'user' ? MAX_MESSAGE_LENGTH : 4000)) {
      throw new InvalidConversationError(`Messages must be 1 to ${MAX_MESSAGE_LENGTH} characters`);
    }
    if (index === messages.length - 1 && expectedRole !== 'user') {
      throw new InvalidConversationError('The last message must be from the user');
    }
    return { role: expectedRole, content };
  });
}

class InvalidConversationError extends Error {}

/**
 * Make sure a reply ends with the sign-off line exactly once
 * @param {string} text - Reply text from the model
 * @returns {string} Reply with sign-off
 */
function withSignOff(text) {
  const body = text.replace(/\s*—?\s*Hadi Medical Clinic, powered by London International · lisrc\.ae\s*$/, '').trim();
  return `${body}\n${SIGN_OFF}`;
}

class AssistantService {
  /**
   * Get the assistant's reply to a conversation
   * @param {Array} messages - Conversation from the browser
   * @returns {Promise<string>} Reply text
   */
  static async reply(messages) {
    const apiMessages = toApiMessages(messages);

    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 1024, // room for adaptive thinking plus a short answer
      output_config: { effort: 'low' },
      system: SYSTEM_PROMPT,
      messages: apiMessages
    });

    if (response.stop_reason === 'refusal') {
      return withSignOff(`Sorry, I can't help with that here. For anything else, please call us on ${CLINIC_PHONE}.`);
    }

    // The response can start with thinking blocks, so pick the text by type
    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim();

    if (!text) {
      return withSignOff(`Sorry, I couldn't answer that. Please call us on ${CLINIC_PHONE}.`);
    }
    return withSignOff(text);
  }
}

AssistantService.ASSISTANT_NAME = ASSISTANT_NAME;
AssistantService.SIGN_OFF = SIGN_OFF;
AssistantService.SYSTEM_PROMPT = SYSTEM_PROMPT;
AssistantService.InvalidConversationError = InvalidConversationError;
AssistantService.APIError = Anthropic.APIError;
AssistantService.RateLimitError = Anthropic.RateLimitError;
AssistantService.AuthenticationError = Anthropic.AuthenticationError;
AssistantService.APIConnectionError = Anthropic.APIConnectionError;

module.exports = AssistantService;
