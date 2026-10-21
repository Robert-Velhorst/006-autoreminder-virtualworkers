# Export and Email Output Safety

## CSV Reports

Both report exports use `server/utils/csv.ts`. Text that could begin a
spreadsheet formula is prefixed with an apostrophe before CSV delimiter
escaping. Leading whitespace, control and formatting characters are considered
when detecting `=`, `+`, `-` and `@`, including full-width variants. Finite JavaScript numbers retain their
numeric representation, including negative values; numeric-looking strings
remain untrusted text. Quotes, commas and embedded line breaks are escaped as
CSV data, not removed.

This deliberately changes the exported representation of formula-capable text.
The apostrophe must not be stripped by downstream import processing. Automated
serialization tests are not evidence of behavior in every spreadsheet client;
the supported Excel/Sheets import workflows still require operator acceptance.
Future CSV exports must use the same serializer rather than local string joins.
In particular, Excel can discard escaping when a CSV is saved and reopened;
this mitigation does not guarantee safe round trips. Do not import a rewritten
file as trusted input. [OWASP's CSV injection guidance](https://community.owasp.org/attacks/CSV_Injection)
describes these client-dependent limitations; no universal CSV representation
is safe for every spreadsheet and downstream consumer.

## Email Templates

Briefing and end-of-day task details, names, dates and other dynamic text must
be HTML-escaped. Dynamic CSS values must be constrained to numeric ranges, not
interpolated as arbitrary strings. Links require HTTP(S) URLs without embedded
credentials and HTML attribute escaping. Invalid structured links fail before
delivery instead of becoming active markup.

Digest, priority-notification and reminder templates already have text-escaping
boundaries. Provider-boundary authorization, persisted recipient consent,
notification kill switches and lease fencing remain separate requirements;
safe rendering does not grant permission to send.

The low-level delivery adapter accepts intentional template HTML. It is not a
general HTML sanitizer and must not receive raw provider/user HTML as trusted
markup. Tests intercept delivery adapters and must not send real messages.

## Acceptance Boundary

Focused route, rendering and mocked-delivery tests cover generated payloads.
They do not establish real mailbox rendering, deliverability, production
configuration, authorization across every application route, or production
readiness of the application as a whole.
