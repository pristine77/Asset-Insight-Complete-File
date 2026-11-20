/*
 * Native Android camera video controls (owner, 2026-11-19): "can the video pause
 * actually pause the video, the paused video can be unpaused to continue the same
 * video. Stop video is when the video ends and saves."
 *
 * Before: the record button showed a pause sign (||) while recording but stopped
 * and saved the video. Now that button pauses / resumes the SAME CameraX
 * recording, and a separate Stop button beside the timer ends and saves it.
 */
import fs from 'node:fs';
import path from 'node:path';

const main = path.resolve(__dirname, '../../modules/auction-camera/android/src/main');
const read = (file: string) => fs.readFileSync(path.join(main, file), 'utf8');
const activityFile = 'java/expo/modules/auctioncamera/ui/camera/CameraViewActivity.kt';
const engineFile = 'java/expo/modules/auctioncamera/viewextensions/CameraViewEngine.kt';
const between = (source: string, start: string, end: string) =>
  source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start) + start.length));

describe('native camera video Pause / Resume / Stop', () => {
  it('pauses and resumes the same CameraX recording and follows its events', () => {
    const engine = read(engineFile);
    const pause = between(engine, 'fun pauseRecording()', 'fun resumeRecording()');
    expect(pause).toContain('active.pause()');
    expect(pause).toContain('if (!firstFrameConfirmed || elapsed < MIN_RECORDING_MS) return false');
    const resume = between(engine, 'fun resumeRecording()', 'fun stopRecording()');
    expect(resume).toContain('active.resume()');
    expect(engine).toContain('is VideoRecordEvent.Pause -> {');
    expect(engine).toContain('is VideoRecordEvent.Resume -> {');
    expect(engine).toContain('fun isRecordingPaused() = recording != null && isPaused');
  });

  it('makes the record button pause / resume while recording, never stop', () => {
    const activity = read(activityFile);
    const button = between(activity, 'binding.imageViewRecordVideo.setOnClickListener {', 'currentCameraMode == CameraMode.VIDEO && isVideoReady ->');
    expect(button).toContain('engine.isRecordingPaused()');
    expect(button).toContain('engine.resumeRecording()');
    expect(button).toContain('engine.pauseRecording()');
    expect(button).not.toContain('engine.stopRecording()');
  });

  it('ends and saves the video only from the Stop button, paused or not', () => {
    const activity = read(activityFile);
    const stopButton = between(activity, 'binding.buttonStopVideo.setOnClickListener {', 'binding.imageViewRecordVideo.setOnClickListener {');
    expect(stopButton).toContain('stopVideoAndSave()');
    const stop = between(activity, 'private fun stopVideoAndSave()', 'private fun onRecordingSaved(');
    expect(stop).toContain('engine.stopRecording()');
    expect(stop).toContain('binding.buttonStopVideo.visibility = View.GONE');
    for (const layout of ['res/layout/activity_camera_view.xml', 'res/layout-land/activity_camera_view.xml']) {
      const xml = read(layout);
      expect(xml).toContain('android:id="@+id/buttonStopVideo"');
      expect(xml).toContain('android:contentDescription="Stop video and save"');
    }
  });

  it('shows PAUSED with the time held, and does not count paused seconds', () => {
    const activity = read(activityFile);
    expect(activity).toContain('if (!isVideoPaused) recordingSeconds++');
    expect(activity).toContain('(if (isVideoPaused) "PAUSED " else "")');
    const shown = between(activity, 'private fun showVideoPaused(paused: Boolean)', 'private fun stopVideoAndSave()');
    expect(shown).toContain('ColorStateList.valueOf(AMBER)');
    // Owner, 2026-11-19: "make the paused button more obvious. Not grey color".
    expect(activity).toContain('if (paused) R.drawable.ic_video_resume else R.drawable.ic_pause');
    const resumeIcon = read('res/drawable/ic_video_resume.xml');
    expect(resumeIcon).toContain('android:fillColor="#16A34A"');
    expect(activity).toContain('engine.onVideoRecordingPaused = { runOnUiThread { showVideoPaused(true) } }');
    expect(activity).toContain('engine.onVideoRecordingResumed = { runOnUiThread { showVideoPaused(false) } }');
  });
});
