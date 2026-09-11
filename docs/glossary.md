# Canonical domain glossary

| Term | Definition |
| --- | --- |
| Communications hub | The application-level service owning conversations, transcript storage, search, and capture status for one BB instance. |
| Source adapter | Code translating an external input into the hub's transcript format. Platform-specific behaviour belongs here. |
| Source connection | A configured input using a source adapter. The MVP has one file-import connection and at most one Zoom connection. |
| Space | An ongoing place where communication happens, such as a channel or recurring meeting series. Future adapters can group conversations under a space. |
| Conversation | A bounded context that a BB thread attaches to: a meeting occurrence, an imported transcript, or a future channel time window. It has a hub-owned ID independent of its source. |
| Meeting | A synchronous conversation occurrence. It is a kind of conversation, not the hub’s generic term. |
| Conversation entry | A generic unit of communication, such as a chat message or transcript segment. The MVP implements transcript segments; future chat adapters must preserve message IDs, edits, replies, and provenance. |
| Transcript segment | An immutable passage with a stable ID, ingestion sequence, text, provenance, and available speaker and timing information. |
| Thread attachment | A thread's reference to one conversation and its own reading position. Detaching does not stop capture or delete the conversation. |
| Capture | Receiving live transcription into the hub. It belongs to the hub, not a thread or agent session. |
| Capture state | Whether capture is connecting, capturing, paused, stopped, interrupted, or ended; idle means no live capture (such as an import). |
| Reading cursor | A per-thread acknowledged ingestion sequence. Reading/searching does not advance it implicitly. |
| Source key | Adapter-provided identity used to deduplicate retransmitted segments within a conversation. |
| Provenance | The source connection, external occurrence identity, and source key explaining where a segment came from. |

Use “conversation” in the UI. “Current conversation” resolves the current thread attachment; it is not global hub state. “Conversation context” means retrieved information, not another stored entity. Timestamps in transcript segments are source-relative milliseconds (file start, or the Zoom adapter’s first capture anchor) or null when unknown; receipt times are Unix milliseconds. The ingestion sequence, not speech time, orders cursor reads so late packets remain discoverable.

## Spaces and time windows

The MVP implements conversation attachments and transcript segments. Space subscriptions, Slack/Discord connections, and automatic daily windows are future work. A calendar day is a view/window of a space in its explicitly selected IANA timezone, not a reason to discard reply relationships or split stored messages irreversibly. Do not add channel APIs until an adapter needs them. Keep window membership based on event time and reading cursors based on ingestion sequence.

**Known interruptions** count pauses, local stops, transport failures, and restarts observed during capture. They indicate possible gaps; zero is not proof of complete capture. Zoom speech timing is relative to first capture, which can start after the meeting.
