export interface BudgetIntent {
  detected: boolean;
  value?: number;
  span?: string;
}

const AMOUNT_PATTERN = `(\\d+(?:,\\d+)*(?:\\.\\d+)?)`;
const MULTIPLIER_PATTERN = `(k|thousand|lakh|lac)?`;

// Individual pattern builders
function buildRegex(prefix: string): RegExp {
  return new RegExp(`${prefix}\\s*${AMOUNT_PATTERN}\\s*${MULTIPLIER_PATTERN}\\b`, "i");
}

const PATTERNS: { regex: RegExp; prefix: string }[] = [
  { prefix: "under", regex: buildRegex("\\bunder") },
  { prefix: "below", regex: buildRegex("\\bbelow") },
  { prefix: "budget of", regex: buildRegex("\\bbudget\\s+of") },
  { prefix: "spend up to", regex: buildRegex("\\bspend\\s+up\\s+to") },
  { prefix: "max", regex: buildRegex("\\bmax(?:imum)?") },
];

const MULTIPLIERS: Record<string, number> = {
  k: 1000,
  thousand: 1000,
  lakh: 100000,
  lac: 100000,
};

export function extractBudgetIntent(userMessage: string): BudgetIntent {
  const msg = userMessage.trim();
  if (!msg) return { detected: false };

  for (const { regex } of PATTERNS) {
    const match = msg.match(regex);
    if (match) {
      const span = match[0].trim();
      const amountStr = match[1].replace(/,/g, "");
      const multiplierRaw = (match[2] || "").toLowerCase();

      const amount = parseFloat(amountStr);
      if (isNaN(amount)) continue;

      const factor = MULTIPLIERS[multiplierRaw] ?? 1;
      const rupees = amount * factor;
      const paise = Math.round(rupees * 100);

      return { detected: true, value: paise, span };
    }
  }

  return { detected: false };
}
