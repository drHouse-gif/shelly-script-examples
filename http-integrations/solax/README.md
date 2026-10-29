# SolaX X3 Hybrid G4 local HTTP integration

[solax-x3-hybrid-g4-local-http.shelly.js](solax-x3-hybrid-g4-local-http.shelly.js)
implements local HTTP communication between a Shelly and a SolaX X3 Hybrid G4
through the inverter's dongle. It sends `ReadRealTimeData` requests, decodes the
returned type-14 telemetry and exposes the values through Shelly Virtual
Components for further use.

A dashboard is a natural next step built on this connection and its telemetry.
The current integration provides the local data access and component values
needed for that extension. Its inverter operations are read-only.

## Local HTTP communication

The Shelly sends the following request to the dongle's local IP address:

```http
POST / HTTP/1.1
Host: <dongle-ip>
Content-Type: application/x-www-form-urlencoded

optType=ReadRealTimeData&pwd=<dongle-serial>
```

The response contains inverter telemetry in the `Data` array, with `type: 14`
identifying the expected layout. Other fields can include `sn`, `ver` and
`Information`. The script checks the response, decodes the selected array entries
and updates the corresponding Virtual Components. No SolaX cloud API is involved
in this exchange.

## Requirements

- A Shelly device with scripting, managed Virtual Components and firmware
  **2.0.0 or later**. The device must expose `Script.getVcHandle()`.
- **Ten available VC slots:** seven numbers, two text components and one group.
  The limit is shared with other scripts and components on the device.
- A dongle exposing local `POST /` with `optType=ReadRealTimeData` and a type-14
  response. Support is specific to the dongle/inverter firmware; a SolaX brand
  name alone does not establish compatibility.
- Network connectivity from the Shelly to the dongle and the **dongle serial
  number**, which is passed as the endpoint's `pwd` parameter.

No Shelly RS485 add-on is required: the Shelly communicates with the dongle over
HTTP. The supplied integration uses the dongle's connection to the inverter.

## Setup

1. Reserve a stable IP address for the dongle in the router.
2. Set `CONFIG.ip` to that address. The published `192.0.2.10` is a documentation
   placeholder; the script deliberately does not query it.
3. Upload the complete script to a compatible Shelly. Keep the `/* @meta ... */`
   declaration first and on one physical line, including its closing delimiter.
   The repository requires that entire line to remain within 1024 characters.
4. Save and start the script. Firmware creates its managed VCs automatically;
   `Group.Set` adds them to the inverter group using their assigned IDs.
5. Enter the actual serial in **Dongle SN**. It is saved across restarts and read
   on each request. Enter only the serial's letters and digits, without spaces.
6. Compare the measurements with the inverter display, including grid and battery
   direction. Enable script autostart if continuous monitoring is desired.

Polling defaults to **15 seconds**, with a **10-second HTTP timeout**. Keep the
polling period longer than the timeout. There is at most one outstanding request.
Changing the serial triggers a new read immediately, or after the pending request
finishes; the old response is discarded.

The group is configured through `Group.Set` rather than the `@meta.members`
syntax introduced in firmware 2.2.0, so the script retains the 2.0.0 managed-VC
API requirement. Stop the script to pause polling. Deleting the script removes
its managed components, including the saved serial.

## Virtual Components and data map

`Data[]` indexes are **zero-based JSON array offsets**, not Modbus register
addresses. The decoding below is preserved from the contributor's working script.

| Role | Display | Data / decoding | Unit | Display range |
|---|---|---|---|---|
| `pv` | PV power | `Data[14] + Data[15]` | W | 0 to 30000 |
| `grid` | Grid power | Signed 32-bit, low word `Data[34]`, high word `Data[35]` | W | -30000 to 30000 |
| `load` | Load power | Signed 16-bit `Data[47]` | W | -30000 to 30000 |
| `bat` | Battery power | Signed 16-bit `Data[41]` | W | -30000 to 30000 |
| `soc` | Battery SOC | `Data[103]` | % | 0 to 100 |
| `totk` | Total energy | Signed 32-bit, low word `Data[68]`, high word `Data[69]`, divided by 10 | kWh | 0 to 999999 |
| `temp` | Heatsink temperature | Signed 16-bit `Data[54]` | °C | -40 to 120 |
| `mode` | Operating status | `Data[19]`, or communication / validation status | — | Text |
| `sn` | Dongle SN | Persisted user input | — | Text |
| `inv` | SolaX X3 Hybrid G4 | Group containing the nine roles above | — | Group |

The original sign interpretation was **grid: positive import / negative export**
and **battery: positive charge / negative discharge**. These direction labels
have not been independently confirmed for the installation, so the power
components expose signed watts without assigning a direction label.
Check the signs against real operating conditions before using them in automations.
The total-energy signed conversion is also retained, rather than silently
substituting a different map. The display ranges are validation bounds, not
inverter nameplate ratings; adjust them to a verified installation if necessary.

Operating codes 0–10 map to Waiting, Checking, Normal, Fault, Perm. Fault,
Updating, EPS Check, EPS Mode, Self Test, Idle and Standby. Other valid codes are
displayed as `Code <number>`.

## Error handling

- Missing configuration produces `Set dongle IP` or `Set dongle SN`.
- Transport failures, non-200 HTTP responses and malformed JSON do not overwrite
  the last measurements. The operating-status tile marks them **stale**.
- A reply without `Data` can indicate an incorrect serial/password or an
  incompatible endpoint. A non-type-14 reply is rejected.
- The parser requires at least 110 array entries and validates each used word
  before decoding. It accepts a numeric `14` or string `"14"` type identifier.
- A snapshot outside the configured display ranges is rejected as a whole.
- A differing returned `sn` is logged without printing either serial, preserving
  the original script's diagnostic behavior.
- UI configuration is written only when it differs. Telemetry values use
  `setValue()` and are not persisted on every poll.

The local endpoint uses HTTP and the serial as its password. Use it on a trusted
local network. The repository contains neither a live address nor a real serial.

## Dashboard as a next step

The exposed PV, grid, load, battery, SOC, energy, temperature and status values
can be used to build a dashboard or further automations. That presentation can
be developed on top of this local HTTP integration. Use the communication/status
component alongside the measurements so a failed read is visible as stale data,
and verify power-direction signs before adding energy-flow labels or logic.

## Validation

The contributor reported successful communication with the inverter using the
original script on **2026-10-29**. The publication version retains its endpoint,
polling defaults, array indexes, scales and mode table, with English comments,
repository metadata and defensive response handling. Exact Shelly model,
firmware builds and individual sign/measurement checks were not supplied.

The Node.js tests exercise script startup and HTTP callbacks with mocked Shelly
APIs, including transport failures, invalid responses and serial changes. They
verify software behavior; they do not establish firmware or physical compatibility.

```sh
node --test http-integrations/solax/tests/local-http.test.cjs
python3 tools/check-manifest-integrity.py --check-headers --check-sync
```

References:

- [Shelly managed Virtual Components](https://shelly-api-docs.shelly.cloud/gen2/Scripts/APIs/Virtual/)
- [Shelly HTTP client](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/HTTP/)
