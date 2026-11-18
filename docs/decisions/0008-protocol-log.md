# 0008. Protocol log with lazy decoding

Status: accepted, 2026-11-18

## Context

Protocol logs down to single bytes are needed for diagnosing devices and firmware variants, and
for bug reports. Decoding every frame eagerly would waste CPU and memory during streaming.

## Decision

One bounded `ProtocolLog` per app. Links log every chunk as received (`rx`) and every write
(`tx`); framers log complete frames (`frame`) with a decoder closure; the session logs lifecycle
events, warnings and errors. Decoding runs only when an entry is expanded or exported. Exports
are JSON with hex bytes, names, text and (optionally) decoded fields, and can be opened again in
the log view.

## Consequences

- Raw chunks show BLE fragmentation and timing; frames show the reassembled protocol view.
- The log format is stable (`format: "ubms-protocol-log"`, `version: 1`).
