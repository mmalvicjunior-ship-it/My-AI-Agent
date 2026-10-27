const explanations = [
  {
    pattern: /\b(api|application programming interface)\b/i,
    text: 'An API is a defined way for one piece of software to request data or actions from another. For example, this app’s frontend calls the Express API to send chat messages and receive replies.',
  },
  {
    pattern: /\b(variable|variables)\b/i,
    text: 'A variable is a named place to store a value so your program can use or update it. For example, `const name = "Ada"` stores the text “Ada” under the name `name`.',
  },
  {
    pattern: /\b(function|functions)\b/i,
    text: 'A function is a reusable block of code that performs a task. It can accept inputs, do some work, and return a result.',
  },
  {
    pattern: /\b(loop|loops|iteration)\b/i,
    text: 'A loop repeats a block of code for each item or while a condition is true. Use a `for...of` loop when you want to process each item in a list.',
  },
];

function calculate(text) {
  const match = text.match(
    /^(?:what is\s+)?(-?\d+(?:\.\d+)?)\s*(plus|\+|minus|−|-|times|×|\*|divided by|\/)\s*(-?\d+(?:\.\d+)?)\s*\??$/i,
  );
  if (!match) return null;

  const left = Number(match[1]);
  const right = Number(match[3]);
  const operator = match[2].toLowerCase();
  let answer;
  if (operator === '+' || operator === 'plus') answer = left + right;
  else if (operator === '-' || operator === '−' || operator === 'minus') answer = left - right;
  else if (operator === '*' || operator === '×' || operator === 'times') answer = left * right;
  else if (operator === '/' || operator === 'divided by') {
    if (right === 0) return 'Division by zero is undefined.';
    answer = left / right;
  }

  return `${left} ${match[2]} ${right} = ${answer}.`;
}

/**
 * Helpful rule-based replies for local development. This provider is not a
 * language model; it responds to common small-talk and simple questions.
 */
export const mockProvider = {
  name: 'mock',
  model: 'offline',

  async chat({ messages }) {
    const userMessages = messages.filter((message) => message.role === 'user');
    const latest = userMessages.at(-1)?.content.trim() || '';
    const normalized = latest.toLocaleLowerCase().replace(/[.!?]+$/g, '').trim();

    let text;
    const calculation = calculate(normalized);
    const explanation = explanations.find(({ pattern }) => pattern.test(normalized));

    if (/^(hi+|h(e|a)y+|hello+|hie|howdy|good morning|good afternoon|good evening)( there)?$/i.test(normalized)) {
      text = 'Hello! How can I help you today?';
    } else if (/^(how are you|how are you doing|you good|are you okay)$/i.test(normalized)) {
      text = 'I’m doing well, thanks for asking! What would you like to work on?';
    } else if (/^(ok(ay)?[, ]+)?(you('re| are) )?(fine|good|great|all good)$/i.test(normalized)) {
      text = 'Thanks! Glad we’re good. What would you like to work on?';
    } else if (/^(thanks|thank you|thx|ty)( so much)?$/i.test(normalized)) {
      text = 'You’re welcome! Happy to help.';
    } else if (/^(bye|goodbye|see you|talk later)$/i.test(normalized)) {
      text = 'See you later! Come back whenever you want to pick this up.';
    } else if (/^(who are you|what are you|are you an ai)$/i.test(normalized)) {
      text = 'I’m the local assistant built into this project. I can handle simple greetings and a few common questions. For broader AI-powered answers, this app needs a valid Gemini or OpenAI API key.';
    } else if (/^(help|what can you do)$/i.test(normalized)) {
      text = 'I can help you plan a project, explain a coding concept, review an error, or suggest a next step. Tell me what you’re working on and we can take it from there.';
    } else if (/\b(tip|tips|advice)\b/i.test(normalized)) {
      text = 'A useful project tip: get one small end-to-end path working first, then improve it in short steps. That makes problems easier to isolate and progress easier to verify.';
    } else if (/\b(let'?s|lets|let us)\b.*\b(work on|start|build|make|plan)\b.*\b(project|app|website|idea)\b/i.test(normalized)) {
      text = 'Absolutely! What are you building, and what would you like to accomplish first? Share a short description or paste the part you want to work on.';
    } else if (calculation) {
      text = calculation;
    } else if (/^(what is|explain|define)\b/i.test(normalized) && explanation) {
      text = explanation.text;
    } else if (/\bproject\b/i.test(normalized)) {
      text = 'Let’s work through it together. What’s the project’s goal, and which part should we tackle first?';
    } else {
      text = 'I can help you think this through. What would be most useful right now: a quick explanation, a plan, or help with a specific problem?';
    }

    // Mock-mode communication: clearly mark simulated/offline replies.
    const isCodingOrFix = /\b(fix|bug|error|fail|broken|refactor|generate|write|create|edit)\b/i.test(normalized);
    if (isCodingOrFix && !calculation) {
      text += " (Note: this is the offline mock provider — simulated output only; no real code was generated or fixed; set AI_PROVIDER to gemini/openai for genuine AI coding.)";
    }
    if (/\b(who are you|what are you)\b/i.test(normalized)) {
      text += " I am running in simulated/mock mode (provider=" + this.name + ", model=" + this.model + "). No real AI language model or autonomous coding capability is active.";
    }

    return { text, provider: this.name, model: this.model };
  },
};
