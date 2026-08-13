# XiaoLu migration audit

LevelUpAgent's Starlight Echo life system was designed after a feature-by-feature review of [UniqueYu8988/XiaoLu](https://github.com/UniqueYu8988/XiaoLu), pinned locally at commit `73b361ecd3ced7e24835802cc30250afe381187c`. This document records behavioral parity and architectural adaptations; it is not a claim that XiaoLu's Electron shell or private runtime data was copied unchanged.

## Feature matrix

| XiaoLu capability | Starlight Echo implementation | Status |
| --- | --- | --- |
| Transparent, always-on-top desktop character | Dedicated borderless Tauri `pet` webview, Windows alpha-area mouse passthrough, taskbar exclusion | Migrated; Tauri adaptation |
| Click, double-click, drag, saved free position | Click reaction, double-click temporary echo conversation, thresholded drag, monitor-relative persistence | Migrated and extended |
| Directional movement | Horizontal autonomous patrol with a six-minute cooldown, favorite-corner visits, drag cancellation, work-area clamping | Migrated; multi-monitor adaptation |
| Smooth `720 ms` directional gait | Eight equal `90 ms` frames selected from absolute `requestAnimationFrame` phase | Migrated and repaired |
| Manual study timing | Start/finish study from the life workspace or reminder prompt; persistent sessions and statistics | Migrated |
| Three study launch periods | 09:00-12:00, 15:00-18:00, 18:00-21:00 | Migrated |
| Start / 10-minute snooze / skip ritual | Persistent interactive overlay prompt; snooze is available once per period | Migrated |
| Four supervision tiers | Morning/afternoon playful, firm, angry, final tiers at 0/5/15/30 minutes after the original launch due time; evening stays gentle | Migrated |
| Strong-supervision patrol | Morning/afternoon reminder states drive bounded patrol and return to the saved free position | Migrated; health and quiet hours take priority |
| Study interruption detection | Manual study sessions complete launch and drive behavior | Adapted without application coupling |
| Five check-ins | 09:00, 12:00, 15:00, 18:00, 21:00 with a +/-5 minute window, missed history, direct overlay response | Migrated |
| Daily and recurring tasks | Persistent tasks, notes, due date, three priorities, daily/weekday/weekly dated occurrences, completion and deletion | Migrated and extended |
| 21:00 and 22:00 task reminders | One persistent reminder per applicable slot with open/dismiss actions | Migrated |
| Automatic daily goals | Configurable study and knowledge targets with progress | Migrated and extended with knowledge goal |
| Automatic bookmarks | Focus, knowledge, and combined bookmarks | Migrated and adapted to LevelUpAgent knowledge |
| Daily plan | Seven locally generated schedule blocks based on tasks, memories, knowledge, needs, and goals | Extended beyond XiaoLu |
| Daily settlement | Reflection, settlement timestamp, rewards, later night stroll | Migrated and extended |
| History and statistics | 30-day summaries, lifetime study/task/check-in/knowledge/reward stats and streak | Migrated and extended |
| Hourly life conversation | Date-rotated low-priority local lines with quiet/check-in exclusions | Migrated conceptually without voice playback |
| Offline voice controls | Reviewed, then removed from the echo runtime and data schema at user request | Intentionally not migrated |
| Login startup | Official Tauri autostart plugin, OS-state verification, startup/selection/restore resynchronization | Migrated; Tauri adaptation |
| YuQuiz companion status and study post | No client, runtime command, persisted fields, UI entry, or export data | Deliberately excluded |
| Local persistence | Versioned Rust state with atomic JSON writes and bounded collections | Migrated; native adaptation |
| Backup | One-click `.levelup-echo` archive containing visuals, manifest, XP, memories, settings, life, tasks, plans, knowledge, and history | Extended beyond XiaoLu |
| Character journal views | Life, plan, knowledge, memory, animation, and hatch workspaces | Architecture adaptation and extension |

## Deliberate adaptations

LevelUpAgent keeps one Tauri application lifecycle rather than embedding XiaoLu's Electron main process, tray implementation, MSI project, or renderer IPC. The existing LevelUpAgent main window is the management surface, and the transparent pet window remains the ambient surface. Temporary echo conversations continue to use LevelUpAgent's provider and permission boundaries.

XiaoLu's bundled character art, pixel font, icon set, recorded voice clips, and generated manual images are not incorporated. The built-in Yui atlas remains LevelUpAgent's asset. Starlight Echoes do not invoke operating-system speech synthesis and expose no offline-voice settings.

YuQuiz coupling was useful during parity research but made the echo feel dependent on another application. It is not part of the migrated product: there is no endpoint client, runtime command, polling, integration setting, persisted snapshot, goal, reward, history metric, movement anchor, or export field. Unknown keys from pre-release state files are discarded when loaded and are not written back or included in a new backup.

## Extensions

Starlight Echo adds persistent needs, autonomous rest and knowledge review, self-formed questions sent to the configured Agent, validated answer provenance and retry state, dream fragments, tentative self-discoveries, favorite-corner visits, touch bonding, source-backed knowledge, conversation-derived memory, generated schedules, multiple installable echo packages, XP, agent activity bubbles, custom hatching, and a validated complete export/restore archive. These are LevelUpAgent features rather than upstream XiaoLu behavior.

## Verification boundary

Parity means each upstream feature was reviewed and deliberately migrated, adapted, or excluded; it does not require keeping every coupling in the active product. The authoritative checks are Rust life-state and backup-schema tests, TypeScript checks, animation/autonomy tests, production builds, and real two-window Tauri smoke tests. XiaoLu remains the behavioral reference under its MIT license; LevelUpAgent's adaptations remain subject to this repository's license.
