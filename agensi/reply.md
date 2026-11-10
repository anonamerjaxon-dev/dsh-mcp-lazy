# Reply to Joeri Brons

Short, and it asks the two things that actually change what gets listed. Send as
plain text; the subject keeps the thread.

**Subject:** `Re: dsh-mcp-lazy → listing it on Agensi`

---

Hi Joeri,

Thanks for reaching out — I'll list something, but two things first.

**1. Which `dsh-mcp-lazy` did you look at?** There are two projects with that
name. One is the npm package `dsh-mcp-lazy` (v0.4.1, `github.com/wings1848/…`,
11 stars). The other is mine: `github.com/anonamerjaxon-dev/dsh-mcp-lazy` — publishing to
npm as `dsh-lazy-mcp`. If you meant the first one, no harm — but I'd rather
know before I package anything, because the two are different codebases.

**2. Can a listing ship instructions for an installable package?** Your Terms
§5.2 say skills are delivered only through the Agensi connector, that nothing is
downloaded to the device, and that a licence doesn't allow saving or exporting
any part of a skill. My project is a plugin with a runtime — it gets installed
from npm, not loaded from a markdown file. My plan is a skill that carries the
configuration and the decision rules, and links to the package. Is that allowed,
or does §6.3a treat the install link as an off-platform upsell?

Also, so I know who I'm talking to: are you on the Agensi team, or a creator who
also does outreach? The affiliate terms suggest the latter, which is fine — I'd
just like to know.

If both answers are workable I'll submit this week. One more: §7.1 lets Agensi
change the 70/30 split with 30 days' notice. How often has that happened?

Best,
Jackson
`github.com/anonamerjaxon-dev`

---

## Why it is worded this way

- **The repo question first.** If he saw the other package, everything after it
  is moot — better to find out before doing the work. It also tells you whether
  his "we saw your project" claim was researched or templated.
- **The §5.2 question is the real one.** It is the difference between a listing
  that can exist and one that cannot. Asking it in terms of their own section
  numbers gets a real answer instead of "should be fine".
- **Naming the affiliate terms is not an accusation.** He wrote "we run
  Agensi.io" and that is not true of a creator account. Asking plainly is
  cheaper than assuming.
- **Do not promise a price, a date, or exclusivity.**

## If he answers "yes, links are fine"

Submit, in this order:

1. Create the account, then **Dashboard → Affiliate** and grab the referral link
   *before* listing. As a creator who is also an affiliate, a buyer you refer
   pays you 70% + 20% = 90%.
2. Set up payouts (Stripe Connect in the EEA, or USDC on Solana via Zoneless).
   Nothing paid out below $3.50.
3. `npm run agensi:build`, then upload `agensi/dist/lazy-mcp-loading-1.0.0.zip`
   at `/dashboard/submit` and paste the fields from `listing.md`.
4. Wait for review (24–48 h), then put the listing URL in the plugin README.

## If he answers "no, the package must be inside the skill"

Then do not list the plugin. Either list the instruction skill *without* the
install link (weaker, but allowed), or skip Agensi and spend the effort on npm —
where the people who would actually install this already search.

## If he never replies

Treat it as a template that was never read. The package is publishable either
way; Agensi is the optional channel, npm is the real one.
