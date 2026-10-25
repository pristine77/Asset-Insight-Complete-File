# Durable report transfer

Android Asset/Lot Submit can hand a prepared upload session to this module. The
caller saves its complete local draft, reserves the exact server upload session,
obtains its seven-day scoped grant, then awaits `enqueue`. A successful return
means the immutable manifest, encrypted authorization and OS scheduling are
durable. A lost acknowledgement must be reconciled with `list`; it must never
fall back to a second JavaScript uploader.

Incoming Create Lot & Continue uses this same unchanged enqueue/worker contract.
The JS owner-bound SQLite continuation journal then reserves and persists the
same-contract empty successor before showing it; the native worker does not
allocate successors or claim early acceptance. Pending reservation retry is
independent of parent upload/Resume. See `../../README.offline-capture.md`.

Android 14+ uses persisted user-initiated JobScheduler transfers. Enqueue/Resume
must occur while the app is visible. Android 7–13 uses WorkManager with a data
sync foreground service. One report/file streams at a time; no whole-file JS
buffer, recompression, original deletion, cloud-backup enablement or normal
access/refresh token is involved. Cache-only and transient gallery references
must first be saved in the draft. Missing/changed originals stop for review.

Metadata and grants live under private `noBackupFilesDir`; grants use Android
Keystore AES-GCM. Each owner/draft/session/revision has an immutable manifest and
small atomic state journal. Routine queue polling and owner/draft lookup read
only compact metadata; selected transfers load the immutable media manifest and
separate verified-file/hash checkpoints. This keeps large manifests out of Binder,
historical queue polls and per-photo manifest rewrites. Header proofs and grants
are encrypted, never reported in status. Identity, generation and attempt checks
fence late work after Pause, logout, owner changes or edited draft handback.

Every attempt checks the exact server session and verifies each pending file
before sending bytes. An exact preparing receipt without an unconfirmed or
unavailable error skips locked media verification and resumes that same session's
idempotent completion. A concurrent verification lock reconciles again; a still
ready session backs off without immediately resending bytes. Multipart fallback
streams the original file. An unaccepted failed session re-verifies/reuploads
only when the server explicitly returns `canResumeUploads: true`; cleanup,
historical handoff, unavailable and unconfirmed sessions remain blocked.
Completion
uses the existing idempotent server boundary, then validates session, owner,
type, report availability and report/job identities. Historical acceptance is
retained as needs-attention. Once completion has been attempted, opening/editing
is refused until that same submission is reviewed/reconciled; ambiguous transport
failure cannot create a new report.

Explicit Pause, resumed work, failed media and observed system/network/unknown
interruptions have durable event IDs and per-session monotonic sequences.
Observed time and app version remain frozen through offline delay. A separate
metadata-only WorkManager outbox can deliver pause evidence without uploading
media. An absent stop callback records unknown, never a fabricated user pause.
Android's explicit pending-user-stop reason records system-stop and holds the
transfer for Resume. Notifications show progress, Pause, attention and accepted
submission; acceptance does not mean server generation or Auctioneer delivery
has finished. Permission denial leaves the in-app status available.

Android can defer or stop work. Force-stop requires reopening; system controls,
expired/revoked grants, missing originals and manufacturer restrictions can
require explicit Resume/re-authentication. This is not an uninterrupted execution
guarantee. Same-owner React/auth hydration preserves scheduled work. Logout
revokes local grants and stops transport, retaining all originals and snapshots.
This module requires a new binary and backend report-transfer support first.

## Local verification

`android/` builds with JDK17 and the existing Expo autolinking; do not prebuild the
canonical native project. The self-contained library test APK has package
`expo.modules.reporttransfer.test`, separate from the customer application.

```sh
./gradlew :report-transfer:assembleDebugAndroidTest --offline --max-workers=2
adb install -r ../modules/report-transfer/android/build/outputs/apk/androidTest/debug/report-transfer-debug-androidTest.apk
adb shell am instrument -w expo.modules.reporttransfer.test/expo.modules.reporttransfer.TransferInstrumentation
```

The default fixture injects a public test-only TLS certificate into the test
process and connects exclusively to loopback HTTPS. It verifies exact original
streaming, lost upload/completion responses, top-level historical receipts,
immutable/changed snapshots, preparing/locked/stale and explicitly repairable
failed-session recovery, cleanup/unconfirmed/unavailable guards, 101 retained
reports with 5,000 references each
and zero manifest loads during queue polling, handback/revision/sequence guards,
Pause, owner fences and actual OS service acceptance. With the emulator offline,
the documented `cmd jobscheduler run -f` override starts only the fixture job;
this exercises the real UIDT service or the older WorkManager foreground service,
not natural live-network scheduling.

API34+ persistence phases use `-e persistencePhase prepare`, then `verify` after
process recreation/reboot, then `cleanup`. They check persisted UIDT metadata,
Keystore authority and original bytes. `crash-prepare` deliberately SIGKILLs only
the library-test process after its actual OS service sends original bytes and
before the response returns; this phase reports an expected instrumentation
process crash. `crash-resume` restarts the actual service against the fixture's
durable receipt, verifies no repeated byte upload, exact accepted completion,
unknown interruption evidence and retained original bytes. `notification` offers
a bounded visual QA window for a real accepted-transfer notification.

These checks do not certify physical-device/OEM endurance, real-provider storage,
natural metered-network handover, app-store signing or production deployment.

Final local verification (2026-10-08): the full fixture passed on API35 (actual
UIDT service) and API29 (actual WorkManager foreground service), including the
guarded failed-session repair and compact historical queue tests above. API35
also passed actual SIGKILL/reopen recovery and persisted-job, Keystore-grant and
original-byte checks after process recreation and emulator reboot. The API29
accepted notification was captured and visually checked after foreground service
completion. Full application debug and instrumentation APK assembly passed;
only the isolated library test package was device-executed. No customer package
was uninstalled, cleared or used as a fixture, and no live API/provider was used.
