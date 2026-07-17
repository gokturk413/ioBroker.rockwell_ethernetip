![Logo](admin/rockwell_ethernetip.png)

# ioBroker.rockwell_ethernetip

[![NPM version](https://img.shields.io/npm/v/iobroker.rockwell_ethernetip.svg)](https://www.npmjs.com/package/iobroker.rockwell_ethernetip)
[![Downloads](https://img.shields.io/npm/dm/iobroker.rockwell_ethernetip.svg)](https://www.npmjs.com/package/iobroker.rockwell_ethernetip)
![Number of Installations](https://iobroker.live/badges/rockwell_ethernetip-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/rockwell_ethernetip-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.rockwell_ethernetip.png?downloads=true)](https://nodei.co/npm/iobroker.rockwell_ethernetip/)

**Tests:** ![Test and Release](https://github.com/gokturk413/ioBroker.rockwell_ethernetip/workflows/Test%20and%20Release/badge.svg)

## rockwell_ethernetip adapter for ioBroker

ioBroker adapter for Rockwell CompactLogix/ControlLogix PLCs via Ethernet/IP

## ⚠️ Disclaimer

**THIS SOFTWARE COMMUNICATES WITH — AND CAN WRITE TO — INDUSTRIAL CONTROL
EQUIPMENT. IT IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED. THE AUTHOR ACCEPTS NO RESPONSIBILITY OR LIABILITY WHATSOEVER FOR ANY
DAMAGE TO EQUIPMENT, LOSS OF PRODUCTION, DATA LOSS, FINANCIAL LOSS, INJURY OR
DEATH ARISING FROM ITS USE OR MISUSE. IT IS NOT DESIGNED, TESTED OR CERTIFIED
FOR SAFETY-CRITICAL OR LIFE-SUPPORT APPLICATIONS AND MUST NEVER BE USED AS
PART OF A SAFETY FUNCTION. YOU USE THIS SOFTWARE ENTIRELY AT YOUR OWN RISK.**

Writing tag values changes the state of a running machine. Always validate the
complete configuration against a non-production controller (e.g. FactoryTalk
Logix Echo) before connecting to a live plant, and make sure only authorized
personnel can access the ioBroker host.

## Features

- All PLC communication runs in a **high-performance native protocol engine** —
  no JS protocol stack
- Driver modes: `standard`, `plantpax_v4` (bulk AOI reads), `plantpax_v5`
  (member-by-member reads, ExternalAccess-filtered writes)
- Tiered polling (fast/normal/slow per tag) with batched change events
- PlantPAx v5 **tag-based alarms** (`@Alarms` tree) from the project file,
  live state over standard CIP reads — no FactoryTalk dependency
- L5K/L5X project parsing for tag browse, alarm definitions and UDT layouts
- On-demand reads, tag leases and stats over `sendTo`

## Requirements

- One of the supported platforms below.
- A license is optional: a built-in **free tier** runs all features on adapter
  instance 0 with up to 1000 tags. Paid editions raise the tag limit and unlock
  additional instances — see [Licensing](#licensing).

## Installation & platform binaries

The PLC engine is a native binary. A single adapter package ships the engine for
every supported platform, gzip-compressed; on first start the adapter expands
only the binary matching the host and loads it — nothing else to install.

Supported platforms: Windows x64, Linux x64, Linux arm64 (Raspberry Pi 4/5,
64-bit), macOS Apple Silicon and macOS Intel. On an unlisted platform the
adapter still installs — it then logs that no engine matched the host and stays
idle instead of crashing.

## Licensing

The **free tier** needs no key: all features, up to 1000 tags, adapter instance 0. Paid editions (Standard/Professional/Unlimited) raise the per-instance tag
limit and the number of instances.

A paid license is issued for the machine that runs the adapter, identified by its
**Hardware ID**. Open the adapter settings → **Connection** tab → **Check License**
to see this machine's Hardware ID, then send it to
[gokturk413](https://github.com/gokturk413) to obtain a key. Paste it into the
**License Key** field and press **Check License** again. A license survives common
hardware changes (disk replacement, added drives); a genuine hardware change can be
re-issued without a new purchase.

## Configuration

| Field                 | Default         | Meaning                                                                   |
| --------------------- | --------------- | ------------------------------------------------------------------------- |
| `plcHost`             | —               | PLC/gateway IP                                                            |
| `plcSlot`             | `0`             | CPU slot (connection path `1,<slot>`)                                     |
| `mode`                | `standard`      | `standard` \| `plantpax_v4` \| `plantpax_v5`                              |
| `licenseKey`          | —               | license key for this machine                                              |
| `projectFile`         | —               | absolute path of the uploaded L5K/L5X (set by the admin upload)           |
| `projectFormat`       | —               | `l5k` \| `l5x` \| `live` — browse source (file upload or live controller) |
| `pollTiers`           | `250/1000/5000` | fast/normal/slow poll periods, ms                                         |
| `cipPayload`          | `0` (auto)      | CIP payload size: `0` auto, `508`, `4002`                                 |
| `parallelConnections` | `1`             | parallel CIP sessions (2–4 multiply read throughput on L8x)               |
| `pushMode`            | `false`         | change-driven push over TCP (needs the generated PLC program)             |
| `pushPort`            | `44819`         | TCP port the engine listens on for the push agent                         |
| `connectionTimeout`   | `5000`          | PLC request timeout, ms                                                   |
| `tags[]`              | `[]`            | `{name, address?, type, tier?, write, unit}`                              |

`name` is the ioBroker state path, `address` the PLC tag path (when absent, `name`
is used for both). Only tags with `write: true` may be written back to the PLC.

> _\*Note on source-protected AOIs (PlantPAx P_* blocks):_* the L5K export stores these
> as encoded blobs without member structure, so their tags appear without children.
> Upload the **L5X** export instead — it carries the full member tree and values for
> every tag, including source-protected AOIs.

## PLC push mode (Phase G)

Polling has a ceiling: per-read cost grows with the number of monitored tags,
so a 12k-tag project sweeps in seconds, not milliseconds. Push mode moves change
detection into the controller — the PLC streams only changed values over a TCP
socket, so pushed tags update in well under a second with near-zero traffic on a
quiet process.

Flow:

1. Browse and add your tags as usual (they get initial values by polling).
2. **Export PLC push program (L5X)** on the Connection tab. The adapter generates a
   partial-import L5X (shadow buffers + `IOB_PushAgent` AOI + a generated
   `IOB_PushMap` routine that copies each selected tag into its slot).
3. Import it in Studio 5000, wire `JSR IOB_PushMap` + the `IOB_PushAgent` call into a
   ~100 ms periodic task, point `IOB_Push_Cfg` at the ioBroker host/`pushPort`, download.
4. Enable **PLC push mode** and restart the adapter. Pushed tags leave polling; the
   engine falls back to polling automatically if the socket goes silent (>10 s) and
   resumes push on reconnect.

Supported by every PlantPAx-5-capable controller (5580/5380/5480, EP/ERMP process
variants) via the embedded Socket Object. v1 pushes BOOL/SINT/INT/DINT/REAL/LINT;
STRING and `@Alarms`/`@AlarmSet` leaves stay on CIP polling. Writes (ioBroker→PLC)
always use the CIP path.

## sendTo API

`browseTags` (model-based, needs `projectFile`), `browseController` (live symbol
list + controller templates over EtherNet/IP; alarm conditions and extended
properties come from the configured project file when present, otherwise the
standard PlantPAx v5 conditions are live-probed per template),
`parseProject {content, format}`,
`parseProjectPath {path, format?}` (parses a saved file from disk — preferred for
large exports), `generatePushProgram {hostIp}` (returns the partial-import L5X for
the current push selection), `parseL5K {fileContent}` (legacy), `testConnection`,
`reloadTags {tags}`, `readValues {paths}`, `leaseTags {paths, ttlMs}`,
`getAlarms {tag?}`, `getStats`, `getLicenseInfo {licenseKey?}`,
`saveProjectFile {name, content}`.

## Native engine

The PLC protocol engine is developed in a **separate private repository**. Its per-platform binaries are
published to npm as the platform packages listed above and are pulled in
automatically on install — nothing to build for adapter users or contributors.

## Development

| Command                    | Description                                   |
| -------------------------- | --------------------------------------------- |
| `npm run build`            | build the admin React UI                      |
| `npm test`                 | adapter unit + package tests                  |
| `npm run test:integration` | boot the adapter against a temporary ioBroker |
| `npm run check`            | TypeScript type check                         |

## Changelog

<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->

### 0.0.14 (2026-07-17)

- (gokturk413) The engine for all platforms now ships in a single npm package (compressed); only the matching binary is expanded on first start

### 0.0.13 (2026-07-17)

- (gokturk413) License activation is stable across common hardware changes — replacing/adding a disk or attaching a USB/external drive no longer affects an existing license
- (gokturk413) A genuine hardware change can be re-issued without a new purchase

### 0.0.12 (2026-07-16)

- (gokturk413) Push auto-recovery after controller outages and Studio downloads
- (gokturk413) Instructions tab fixes (own scrollbar, dark-theme chips), original adapter logo
- (gokturk413) Admin translations for 10 languages; license changed to CC BY-NC 4.0

### 0.0.11 (2026-07-16)

- (gokturk413) License editions with a keyless free tier: Free = all features, up to 1000 tags, instance 0 only; Standard = instances 0..1 with 3000 tags each; Professional = instances 0..2 with 10000 tags each; Unlimited
- (gokturk413) New Instructions tab with step-by-step setup and downloadable source-protected Add-On Instructions

### 0.0.10 (2026-07-16)

- (gokturk413) Group-based PLC push v2: change flags polled over plain CIP (works on FactoryTalk Logix Echo and physical controllers)
- (gokturk413) Engine-managed watch lists that survive Studio downloads, batched shadow reads and change events
- (gokturk413) Hidden AOI internals excluded automatically, scan class "none", group-level scan-class dropdown, fast recursive tag deletion

### 0.0.9 (2026-07-12)

- (gokturk413) Security: the push Add-On Instruction logic no longer ships in any artifact

### 0.0.8 (2026-07-12)

- (gokturk413) PLC push mode over a TCP socket (physical controllers); parallel CIP connections

### 0.0.7 (2026-07-12)

- (gokturk413) Live @Alarms/@AlarmSet, EP properties as file-served states, parallel CIP connections, importTags bulk config

### 0.0.6 (2026-07-10)

- (gokturk413) Live controller browse, batch polling via Multiple Service Packets

### 0.0.5 (2026-07-10)

- (gokturk413) Extended-property nodes, 48-attribute @Alarms tree, commercial license

### 0.0.3 (2026-07-10)

- (gokturk413) Project-file browse for source-protected PlantPAx v5 AOIs (decorated L5X data)

### 0.0.2 (2026-07-09)

- (gokturk413) initial release

## License

Copyright (c) 2026 gokturk413 <gokturk413@gmail.com>

Licensed under **Creative Commons Attribution-NonCommercial 4.0 International
(CC BY-NC 4.0)** — see [LICENSE](LICENSE).

- **Non-commercial use** is free of charge (the adapter additionally ships a
  built-in free tier: all features, up to 1000 tags, adapter instance 0).
- **Commercial use requires a per-machine license key** — see
  [Licensing](#licensing); contact [gokturk413](https://github.com/gokturk413).

The native protocol engine is distributed as prebuilt binaries via the npm
platform packages and enforces the license key at runtime.
