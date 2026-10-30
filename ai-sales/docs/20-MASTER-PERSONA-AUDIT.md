# Master Persona implementation audit (30 Oct 2026)

The owner saved the Hafizan Hanis Master Persona in Settings → AI persona → Tone guidance: 37,791 characters, 1,373
lines. It reaches the AI in full, inside the system prompt ("Tone guidance from the owner"). This audit compares it
with what the code actually does. The persona text was not changed.

## What the code does, area by area
| # | Persona area | Before this audit | Now |
|---|---|---|---|
| 1 | 9-step discovery and pathways | **Missing in code.** The built-in prompt had its own, different list ("own stay or investment, first home, bedrooms, budget…") in another order, with no name, area familiarity, living/work area, commute, marital status, children or showroom history. | `discovery.mjs` works out the next step from the CRM (name, profile, appointments) with the own-stay / investment / both / undecided pathways, the showroom override and "stop when ready". The reply AI gets it as `discovery` and is told to answer first, ask at most one discovery question, skip what was already answered, and keep marital status and children optional. |
| 2 | Profile updates and memory | Works: the insights job updates the client profile after every buyer message; the last 30 messages are sent as history. No field for the preferred name or showroom visits. | Added the profile fields `preferred_name` and `showroom_visit` (no migration: profile is JSON, validated in `profile.mjs`). The insights "next question" follows the same order. |
| 3 | Manglish and emotional intelligence | Prompt level: the persona plus "Mirror Manglish" (on). There is no code check of tone. | Unchanged; check in the test console. |
| 4 | 3 paragraphs / 40 words / 5 bullets / 65 words | Enforced in code (Standard reply style). | **Conflict:** Reply style is set to **Short chat** (7–10 words, at most 15), which overrides these limits. The owner must choose one. |
| 5 | 1–3 message delivery | Works (ordered, idempotent, stops when the buyer writes or a person takes over). | Unchanged. |
| 6 | Google Maps distances | Code ready; **GOOGLE_MAPS_API_KEY not set** (0 lookups ever). | Owner setup needed. |
| 7 | External research | Works in the test console (29–30 Oct: found Mah Sing's M MIRA page in 13 s). **Not in live WhatsApp** (30-second limit): those questions are handed to an advisor. | Incomplete for live WhatsApp. |
| 8 | Property knowledge | Works from the website and staff facts. Data gaps: no showroom address/hours, booking fee, title type or sinking fund for any project; 0 promotions; 0 FAQs; two live M MIRA listings; Wangsa Maju LRT 2 km (list) vs 3 km (text). | Owner data. |
| 9 | LPPSA and bank financing | Deterministic engine, on for live chats. LPPSA rules are marked **unverified** (secondary sources; the official LPPSA FAQ not yet checked). | Unchanged; owner to verify the LPPSA rules. |
| 10 | Human takeover and manual resume | Works (unsent AI messages are skipped; the AI stays paused until resumed). | Unchanged. |
| 11 | Showroom booking | Calendar booking on, but the built-in prompt said to **hand over when the buyer is ready to book**, contradicting the persona. | Now: hand over only for booking a unit, paying or signing; showroom visits are arranged through the calendar slots. |
| 12 | Follow-ups and Telegram | 12-hour follow-up, cancelled on takeover; Telegram limited to new leads, human tasks and appointments. | Unchanged. |

## Other findings
- The greeting fields ("Hi! I'm Hafizan") are **not used** anywhere. The AI always introduces itself as Hafiz_Ai, an AI assistant, as both the persona and the law require.
- About a third of the persona is written for developers (sections 19, "Critical requirement", the test list). It is sent with every reply: extra cost and time on each message, and nothing the AI can act on. Trimming it is the owner's call.
