// Shared safety for provider replies that follow workspace tool calls.
// Both Gemini and OpenRouter must present staged work honestly: a tool result
// with status "awaiting_user_approval" means nothing has been written or run.

// A reply that already talks about the approval flow does not need the
// deterministic note appended.
const APPROVAL_MENTION = /approv|staged|awaiting|pending|review/i;
// Wording that already says the work is not done.
const PENDING_WORDING = /approv|staged|pending|awaiting|not been|has not|hasn['’]t|has yet|yet to|will be|to be applied/i;
// Past-tense verbs that assert the work already happened.
const COMPLETION_VERB = /\b(?:created|creates|wrote|written|saved|added|updated|applied|generated|modified|edited|implemented|executed|ran|run|made|done|completed|finished|populated|filled|inserted|deleted|removed|renamed|moved|copied|committed|deployed|installed)\b/i;
// A future statement is not a false completion claim.
const FUTURE_STATEMENT = /\b(?:will|shall|going to|about to|intend to|plan to|would like to)\b/i;
// Ways a sentence can refer to the pending work without naming it. The
// reference has to sit right after the verb so unrelated sentences survive.
const INDIRECT_REFERENCE = /\b(?:created|creates|wrote|written|saved|added|updated|applied|generated|modified|edited|implemented|executed|ran|run|made|completed|finished|populated|filled|inserted|deleted|removed|renamed|moved|copied|committed|deployed|installed)\b(?:\s+\w+){0,2}\s+(?:the|this|that)\s+(?:file|command|change|edit)\b/i;
const COMPLETION_ADVERB = /\b(?:successfully|already)\b/i;
// One sentence, including its trailing whitespace.
const SENTENCE_PATTERN = /[^.!?\n]*[.!?]+[ \t]*|[^.!?\n]+$/g;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces paths and other dotted tokens with dot-free placeholders so the
 * text can be split into sentences without cutting "notes.txt" in half.
 */
function protectTokens(text, labels) {
  const tokens = [];
  const originals = [];
  let result = text;

  const variants = [];
  for (const label of labels) {
    variants.push(label);
    const base = label.split(/[\\/]/).pop();
    if (base && base !== label) variants.push(base);
  }
  for (const variant of variants) {
    const pattern = new RegExp(escapeRegExp(variant), 'gi');
    if (!result.match(pattern)) continue;
    const token = `\u0001T${tokens.length}\u0001`;
    tokens.push(token);
    originals.push(variant);
    result = result.replace(pattern, token);
  }
  const labelTokens = new Set(tokens);

  result = result.replace(/\b[A-Za-z0-9_'-]+\.[A-Za-z0-9_'-]+\b/g, (match) => {
    const token = `\u0001T${tokens.length}\u0001`;
    tokens.push(token);
    originals.push(match);
    return token;
  });

  return { text: result, tokens, originals, labelTokens };
}

/** The labels of the staged work the user still has to approve. */
function pendingLabels(toolActivity) {
  return toolActivity
    .filter((item) => item.status === 'awaiting approval')
    .map((item) => item.proposal?.path || item.commandApproval?.command)
    .filter((label) => typeof label === 'string' && label.trim());
}

/** The labels of the work whose tool call failed, so the reply cannot claim it. */
function failedLabels(toolActivity) {
  return toolActivity
    .filter((item) => item.status === 'failed')
    .map((item) => item.proposal?.path)
    .filter((label) => typeof label === 'string' && label.trim());
}

/**
 * True when a sentence asserts that the pending work is already done.
 * Only completed work that names the pending path (or refers to it
 * indirectly) counts, so unrelated statements are left alone.
 */
function isFalseCompletionClaim(sentence, labelTokens) {
  if (!COMPLETION_VERB.test(sentence)) return false;
  if (PENDING_WORDING.test(sentence)) return false;
  if (FUTURE_STATEMENT.test(sentence)) return false;
  for (const token of labelTokens) {
    if (sentence.includes(token)) return true;
  }
  if (INDIRECT_REFERENCE.test(sentence)) return true;
  return COMPLETION_ADVERB.test(sentence);
}

/** Removes sentences that claim the pending work is already done. */
function removeFalseCompletionClaims(text, labels) {
  const guarded = protectTokens(text, labels);
  let removed = false;
  const cleaned = guarded.text.replace(SENTENCE_PATTERN, (sentence) => {
    if (!isFalseCompletionClaim(sentence, guarded.labelTokens)) return sentence;
    removed = true;
    return '';
  });
  if (!removed) return text;
  let restored = cleaned;
  guarded.tokens.forEach((token, index) => {
    restored = restored.split(token).join(guarded.originals[index]);
  });
  return restored.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Safety net: if a change is only staged, the reply must not read as if it was
 * already applied. Small models sometimes say "created" first and "staged"
 * later, so false completion claims are removed and an explicit note is added
 * when the reply never mentions the approval flow.
 */
export function withApprovalNotice(text, toolActivity) {
  if (typeof text !== 'string' || !text.trim()) return text;
  const pending = pendingLabels(toolActivity);
  const labels = [...pending, ...failedLabels(toolActivity)];
  if (!labels.length) return text;
  const cleaned = removeFalseCompletionClaims(text, labels);
  if (!pending.length) return cleaned;
  if (APPROVAL_MENTION.test(cleaned)) return cleaned;
  const subject = pending.length > 1 ? `${pending.join(', ')} are` : `${pending[0]} is`;
  const note = `Nothing has been written or run yet: ${subject} staged and waiting for your approval in the app.`;
  return cleaned ? `${cleaned}\n\n${note}` : note;
}
