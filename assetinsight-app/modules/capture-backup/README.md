# Android capture backup module

`CaptureBackup` is an Expo 54 Android module backed by WorkManager 2.12.0.
It is independent of the camera module, React form lifetime, report-upload queue
and report submission. A new installed native binary is required.

Native execution is compiled off unless `EXPO_PUBLIC_CAPTURE_BACKUP_ENABLED` is
exactly `true` when Gradle builds the module. The Play release keeps it `false`
until private storage and production rollout checks are complete. This is not
only a JavaScript toggle: persisted WorkManager jobs from an earlier enabled APK
stop before any network operation, clear old encrypted backup grants and cancel
their scheduling. Originals, immutable snapshots and checkpoints are retained.
Native configure/enqueue/resume and outbound transports also fail closed. Turning
it on later requires a new reviewed binary, backend readiness and user consent.

The bridge persists an immutable owner/draft/revision snapshot before enqueue
returns. WorkManager input contains only an opaque queue ID. Private atomic files
under `noBackupFilesDir/capture-backup-v1` hold metadata and original URI references;
the module never creates another original-sized copy, changes photo encoding, or
removes an original. Backup-only grants and device headers are encrypted with
Android Keystore AES-GCM. No bearer or refresh token is accepted by this bridge.

Workers stream SHA-256 and positive byte-size measurements, including originals
whose saved size was unknown. Measured receipts are separate from the immutable
local snapshot. Each worker processes small target groups within a four-minute
slice, checkpointing each verified file and yielding through a new WorkManager
request. Up to two native HTTP operations run concurrently across captures.
PUT requests preserve existing object keys (`If-None-Match: *`); a lost response
is reconciled through the same immutable plan and server verification. Report
generation/preview/submission endpoints are outside the transport allowlist.

The shared limits are 5,000 photos, 1,000 videos and 6,000 total media entries,
with 50 MiB/photo, 512 MiB/video, 20 GiB total and the backend's 2 MiB metadata
limit. PUTs use idle timeouts rather than a whole-transfer 120-second deadline.
Android's worker execution limit still applies: very large clips on a slow
connection may need a faster connection to finish within the available window.

Pause is persisted across revisions, app exits and restarts. Draft deletion
adds a durable non-resumable pause tombstone. Pause/Resume applies to all retained
pending revisions. A newer snapshot that drops an earlier original cannot cancel
the earlier incomplete backup. UI summaries describe the latest revision's own
counts and expose retained earlier pending revisions separately. Compact status
files keep polling and streaming permission checks independent of large manifests.

Owner changes and logout clear native authority and cancel work without removing
metadata/originals. Changing network policy or renewing a grant invalidates old
workers and reschedules with the new constraints. Worker-attempt fences reject
late callbacks. Seven-day grants require foreground renewal after expiry.

Activity events have stable IDs, a durable per-capture sequence across revisions,
and occurrence timestamps. The metadata-only event route works before plan
registration and while media is paused. A user pause, known network constraint,
known Android stop and unexplained prior-process exit remain distinct. Missing
termination evidence is recorded as unknown, never guessed to be a user action.

## Verification

With the setting absent or `false`, the same instrumentation runner executes the
disabled-release upgrade fixture instead: it seeds a prior grant and delayed job,
checks native entry-point/transport rejection, cancellation and revocation, and
verifies the original bytes and retained job snapshot are unchanged. Use the
explicit `true` setting below only for the isolated enabled-backup test suite.

The separate library test APK does not launch React, sign in to production or
access the customer app. Build it from the native `android/` directory with JDK17:

```sh
EXPO_PUBLIC_CAPTURE_BACKUP_ENABLED=true ./gradlew :capture-backup:assembleDebugAndroidTest --max-workers=2 --console=plain -PreactNativeArchitectures=arm64-v8a
```

Install `modules/capture-backup/android/build/outputs/apk/androidTest/debug/capture-backup-debug-androidTest.apk`,
then invoke:

```sh
adb shell am instrument -w expo.modules.capturebackup.test/expo.modules.capturebackup.BackupInstrumentation
```

The API35 fixture checks private queue reload, 5,000-photo manifests plus a clip,
unknown byte size, SHA-256, exact streamed HTTPS bytes, a lost PUT response with
no second upload, encrypted credentials, owner fencing, shorter-revision
preservation, Pause/Resume/deletion and interruption/resume observations.

Actual WorkManager persistence uses the production scheduler with a one-day
test-only initial delay so no background network request can escape the fixture:

```sh
adb shell am instrument -w -e persistencePhase prepare expo.modules.capturebackup.test/expo.modules.capturebackup.BackupInstrumentation
adb shell am kill expo.modules.capturebackup.test
adb shell am instrument -w -e persistencePhase verify expo.modules.capturebackup.test/expo.modules.capturebackup.BackupInstrumentation
adb reboot
# Wait for the isolated emulator to finish booting.
adb shell am instrument -w -e persistencePhase verify expo.modules.capturebackup.test/expo.modules.capturebackup.BackupInstrumentation
adb shell am instrument -w -e persistencePhase policy-cleanup expo.modules.capturebackup.test/expo.modules.capturebackup.BackupInstrumentation
```

These phases check the queued WorkManager request and encrypted state after
process recreation and reboot, then verify that Wi-Fi-only policy replaces
the request's constraints while preserving checkpoints. They do not certify
uninterrupted real-photo transfer through reboot, physical OEM behavior,
5,000-original endurance, or production storage/provider configuration.

WorkManager survives ordinary app closure and schedules work across device
reboots. Android controls execution timing, battery restrictions and quotas.
Force-stop prevents background execution until the user opens the app again;
some manufacturers also treat removing an app from Recents this way. This module
cannot promise immediate or uninterrupted execution in those states.
