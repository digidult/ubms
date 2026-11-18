# 0009. Protocol detection by probing

Status: accepted, 2026-11-18

## Context

Several BMS brands share the same BLE UUIDs (for example FFE0/FFE1), names are often changed by
users, and serial adapters reveal nothing about the device behind them.

## Decision

Detection ranks candidates (name patterns first, then services present, then registration order)
and probes them one by one. A probe sends a harmless read request and validates the answer
(preamble, checksum, frame type). The first positive probe wins and reports the protocol variant.
An explicit selection (brand or protocol) narrows the candidates; the UI tells the user when
filtering the chooser is impossible.

## Consequences

- Probes must never change device state.
- Auto detection on serial may take a few seconds (several baud rates).
- Adding a driver automatically adds it to detection.
