# LevelUpAgent chat gateway — protocol 1

Original, account-isolated adapter layer. Dependencies: official Feishu
lark-oapi 1.7.5, DingTalk dingtalk-stream 0.24.3, Tencent qq-botpy 1.2.1,
websockets 12.0 and httpx 0.28.1. Direct versions are pinned in requirements.txt.
requirements-lock-windows-py310.txt records the tested transitive dependency
snapshot; it is not a cross-platform lockfile.

## Source references (2026-10-18)

- https://github.com/larksuite/oapi-sdk-python — MIT
- https://github.com/open-dingtalk/dingtalk-stream-sdk-python — MIT
- https://github.com/tencent-connect/botpy — MIT metadata / upstream license
- https://github.com/botuniverse/onebot-11 — external protocol compatibility

SDK distributions retain their own licenses. No AstrBot, MaiBot, WeChat hook or
NapCat implementation is copied or bundled. The lark-channel high-level API was
evaluated but not used because it schedules callbacks before durable host ACK.

## Protocol

First host frame: configure, version 1, account metadata and secret, sent through
stdin only. Child frames: status, inbound, delivery. Host frames: ack, send.
UTF-8 newline-delimited JSON, 64 KiB maximum. One process per account.
Inbound requests wait up to two seconds for host SQLite commit. Outbox commands
have immutable delivery IDs and are attempted once; ambiguous transport results
remain delivery_unknown. Only visible final answer text is sent. SDK logs and
prints are disconnected from protocol stdout. Callback URLs and credentials
never enter model context.

## Verification

python gateway.py --check imports dependencies. python -m unittest -v
test_gateway covers normalization, official SDK dispatch/send contracts, ACK
ordering, QQ resume rollback, and a real stdio child with an authenticated mock
OneBot server. This does not substitute for actual platform account validation.

## Windows DingTalk desktop (2026-10-20, experimental)

`desktop_gateway.py` uses the same stdio protocol with a separate optional
runtime (`requirements-desktop.txt`, Windows Python 3.10-3.12). Configure includes
`account.desktop` calibration and active allowlisted `routes`; no secret is used.
`--probe` enumerates real DingTalk windows and optionally returns a local screenshot
and OCR preview. It never sends messages. `--state` is a host-selected local file
for atomic inbound buffering and durable outbound intent.

Read `docs/DINGTALK_DESKTOP_2026-10-20.md` for setup and limitations.
`python -m unittest discover -s modules/chat_gateway -p 'test_desktop*.py'`
tests rules, image filtering and send guards. Synthetic tests and screenshot
recognition do not prove real DingTalk UIA compatibility or live delivery.
