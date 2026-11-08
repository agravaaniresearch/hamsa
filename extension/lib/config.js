// Every tunable in one place. The whole object is written into thread.json,
// so any run can be reproduced exactly.
export const DEFAULTS = {
  // pruning
  maxDownvotes: 4,          // HN Companion rule: 4 or more downvotes is excluded
  minWords: 15,             // shorter than this is dropped unless it carries evidence
  chainMinRun: 5,           // A B A B A alternation of this length counts as a flame chain (4 over-pruned real technical Q&A)
  chainKeepWords: 100,      // a chain member this long is substantive, so it stays
  budgetTokens: 30000,      // input cap for comments (HN Companion caps hosted models at 25000)
  opBoost: 1.3,
  evidenceBoost: 1.15,
  relLambda: 0.8,           // priority = hn_score * (1 + relLambda * rel); rel in [-1, 1]
  relKeep: 0.5,             // a comment this relevant is exempt from the short and flame-chain rules
  // text shaping
  snippetChars: 140,        // parent snippet shown on a reply
  quoteMaxChars: 240,       // long quoted paragraphs (lines starting with >) are trimmed
  codeMaxChars: 600,
  commentMaxChars: 2500,
  urlMaxChars: 100,
  lineOverheadTokens: 20,   // header and snippet cost per comment, used for budgeting
};

export const TOKENS_PER_CHAR = 0.25; // same estimate HN Companion uses
export const estTokens = (s) => Math.ceil(s.length * TOKENS_PER_CHAR);
