# Appointments: close, cancel and archive (2026-10-28)

On **Appointments**, every row has **Close…**:

| Choice | Shown for | What happens |
|---|---|---|
| Done – we met | confirmed / rescheduled | Status *completed*. No message, no alert. |
| No-show | confirmed / rescheduled | Status *no-show*. Telegram reminds you to follow up (appointment category). |
| Cancel appointment / request | pending, confirmed, rescheduled | Status *cancelled*; WhatsApp reminders stop. If it is on Google Calendar, the event is deleted first. If the event cannot be deleted, nothing changes and you are told why. The buyer is **not** messaged. Telegram sends the usual "Appointment cancelled" alert. |
| Archive (hide from list) | anything except a booked appointment still ahead | Hidden from *Upcoming & pending* and *All*, and from the Overview. Status, reminders and alerts are untouched, and nothing is deleted. **Archived** lists them, with **Restore**. |

A booked appointment that is still ahead cannot be archived, so its reminders never go out for a hidden appointment. Cancel it, or mark it done, first.

- **Database:** `ai_appointments.archived_at`, `archived_by` (migration 12, additive). Advisors and above can archive and restore (existing row rules).
- **Server:** `POST /api/sales/appointments/cancel` (advisor+), which deletes the Google Calendar event via `cancelEvent`.
- **Not changed:** the daily digest's count of "requests without a confirmed time" still includes archived pending requests.
- **Tests:** unit (cancelEvent, cancel endpoint), browser (archive, restore, cancel), layout (Close dialog at 12 widths), database T54.
