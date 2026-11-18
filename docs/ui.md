# UI structure and navigation

The UI is designed for phones first: one hand, a bottom tab bar, large touch targets (44 px),
safe-area insets for notches and home indicators. Wide screens (900 px and more) get a side rail
and multi-column layouts.

## Modes

| Mode | Navigation items | Notes |
| --- | --- | --- |
| Not connected | Connect, Log, More | Device screens redirect to Connect. |
| Connected / reconnecting | Overview, Cells, Settings, Log, More | Overview shows a badge with the number of active alarms. |

After a successful connection the app opens Overview; after disconnecting it returns to Connect.

## Screens

| Route | Screen | Content |
| --- | --- | --- |
| `#/connect` | Connect | Connection type (Bluetooth, Serial, Demo), BMS type (auto, brand, protocol), chooser options, browser support notices, detection progress, recent devices. |
| `#/overview` | Overview | SOC ring and state, voltage, current, power, remaining capacity; alarms; switches (toggles when the driver can write them); cell summary with bars; temperatures; battery details (cycles, SOH, capacities, time to full or empty); 10 minute trend; driver specific values. |
| `#/cells` | Cells | Count, average, min, max, delta, balancer state; a tile per cell with voltage or deviation from average, balancing flag, connection resistance; min and max highlighted. |
| `#/settings` | Settings groups | Generated from the driver schema. Toolbar: reload, export to JSON, import from JSON (shown as pending changes). |
| `#/settings/<group>` | Settings group | Fields with limits and help; pending changes are highlighted, validated (field limits and cross-field rules) and applied in one batch after a confirmation that lists old and new values. Each field shows whether the device confirmed the value. Actions (restart, reset, calibration) need confirmation. |
| `#/info` | Device information | Identity reported by the device and connection details (GATT service and characteristics or port and baud rate, traffic counters). |
| `#/log` | Protocol log | Live list with filters (sent, raw received, frames, events, warnings, errors, debug), text or hex search, pause, expandable entries (hex dump, decoded fields, copy), export JSON or text, open saved logs. |
| `#/prefs` | Preferences | Language, theme, refresh interval, keep screen on, advanced settings, log size, reset. |
| `#/more` | More | Device information, preferences, log, disconnect, about. |

## Device types

The views render only data that is present in the snapshot, so a balancer (no current, no
MOSFETs) or a BMS without temperature sensors gets a shorter screen automatically. Meters and
electronic loads (`deviceType: 'meter'`, for example Atorch) have no cells: the Cells tab is
hidden for them and their readings (energy, capacity, duration, load settings) appear as values
and settings of the driver. Device specific
parameters come from the driver schema as extra fields and groups. Drivers can add specific values
to `snapshot.extra`; Overview lists them under "More values".

## Real time behaviour

- The session emits a snapshot per poll or streamed frame; views subscribe to store slices and
  re-render only changed parts (Lit templates).
- The header shows a live indicator with SOC while data is fresh and "No data" when nothing
  arrived for four poll intervals (at least 8 s).
- The log view batches updates to one render per animation frame.
- Optional screen wake lock while a device is connected and the app is visible.
