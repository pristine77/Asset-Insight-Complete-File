package com.assetinsight.app;

import android.content.Context;
import expo.modules.auctioncamera.CaptureJournal;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.UUID;

/** Isolated metadata assertions; no app login, gallery deletion, or network calls. */
final class CaptureJournalAssertions {
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
    static void run(Context context) throws Exception {
        activityHistory(context);
        String owner = "qa-owner-" + UUID.randomUUID();
        String draft = "qa-draft-" + UUID.randomUUID();
        String session = UUID.randomUUID().toString();
        JSONObject identity = new JSONObject().put("ownerId", owner).put("draftId", draft).put("sessionId", session);
        JSONArray lots = new JSONArray().put(new JSONObject().put("id", "stable-lot").put("files", new JSONArray().put(new JSONObject().put("uri", "content://media/external/images/media/123").put("mediaId", "stable-photo"))));
        JSONObject first = CaptureJournal.INSTANCE.save(context, identity, new JSONObject().put("completedLots", lots), lots);
        JSONObject second = CaptureJournal.INSTANCE.save(context, identity, new JSONObject().put("completedLots", lots), lots);
        check(second.getLong("revision") == first.getLong("revision") + 1, "Journal revisions did not advance");
        check(CaptureJournal.INSTANCE.read(context, "other-" + owner, draft) == null, "Another owner could read a journal");
        check(!CaptureJournal.INSTANCE.acknowledge(context, owner, draft, session, first.getLong("revision")), "Stale acknowledgement deleted new capture");
        check(!CaptureJournal.INSTANCE.acknowledge(context, owner, draft, "other-session", second.getLong("revision")), "Wrong session acknowledgement succeeded");
        JSONObject reopened = CaptureJournal.INSTANCE.read(context, owner, draft);
        check(reopened != null && reopened.getJSONArray("lots").getJSONObject(0).getString("id").equals("stable-lot"), "Journal did not retain original lot ID");
        check(CaptureJournal.INSTANCE.acknowledge(context, owner, draft, session, second.getLong("revision")), "Current committed revision did not acknowledge");
        check(CaptureJournal.INSTANCE.read(context, owner, draft) == null, "Acknowledged journal remains pending");
        JSONObject afterAcknowledgement = CaptureJournal.INSTANCE.save(context, identity, new JSONObject().put("completedLots", lots), lots);
        check(afterAcknowledgement.getLong("revision") > second.getLong("revision"), "Journal revision reset after acknowledgement");
        check(!CaptureJournal.INSTANCE.acknowledge(context, owner, draft, session, second.getLong("revision")), "Old acknowledgement deleted a later capture");
        check(CaptureJournal.INSTANCE.read(context, owner, draft) != null, "Later capture was lost after stale acknowledgement");
        check(CaptureJournal.INSTANCE.acknowledge(context, owner, draft, session, afterAcknowledgement.getLong("revision")), "Later current revision could not acknowledge");
    }

    private static void activityHistory(Context context) throws Exception {
        String owner = "activity-qa-" + UUID.randomUUID(), draft = UUID.randomUUID().toString(), session = UUID.randomUUID().toString();
        JSONObject identity = new JSONObject().put("ownerId", owner).put("draftId", draft).put("sessionId", session);
        CaptureJournal.INSTANCE.save(context, identity, new JSONObject().put("activeLotNumber", 1), new JSONArray());
        JSONArray lots = new JSONArray();
        for (int l = 0; l < 25; l++) {
            JSONArray photos = new JSONArray();
            for (int p = 0; p < 200; p++) photos.put(new JSONObject().put("mediaId", "photo-" + l + "-" + p).put("uri", "content://qa/" + l + "/" + p).put("captureOrigin", "camera"));
            lots.put(new JSONObject().put("id", "lot-" + l).put("lotNumber", String.valueOf(l + 1)).put("coverIndex", 0).put("files", photos));
        }
        JSONObject captured = CaptureJournal.INSTANCE.save(context, identity, new JSONObject().put("activeLotNumber", 2), lots);
        JSONArray events = captured.getJSONArray("activity");
        int photoCount = 0; boolean next = false;
        for (int i = 0; i < events.length(); i++) {
            JSONObject event = events.getJSONObject(i);
            if (event.getString("action").equals("photo_captured")) {
                JSONObject detail = event.getJSONObject("data").getJSONArray("lots").getJSONObject(0);
                JSONArray photos = detail.getJSONArray("photos");
                check(photos.length() <= 100, "Unbounded photo activity batch");
                check(detail.has("lotNumber"), "Displayed lot number missing");
                photoCount += photos.length();
            }
            if (event.getString("action").equals("next_lot")) next = true;
        }
        check(photoCount == 5000 && next, "Capture/Next Lot history incomplete");
        check(!events.toString().contains("content://"), "Local paths leaked into activity");
        JSONObject firstLot = lots.getJSONObject(0);
        JSONArray before = firstLot.getJSONArray("files"), reordered = new JSONArray().put(before.getJSONObject(199));
        for (int p = 1; p < 199; p++) reordered.put(before.getJSONObject(p));
        firstLot.put("files", reordered).put("coverIndex", 2);
        JSONObject changed = CaptureJournal.INSTANCE.save(context, identity, new JSONObject().put("activeLotNumber", 2), lots);
        String changes = changed.getJSONArray("activity").toString();
        check(changes.contains("photos_removed") && changes.contains("photos_reordered") && changes.contains("cover_changed"), "Removal/reorder/cover history missing");
        check(changed.getJSONArray("activity").getJSONObject(changed.getJSONArray("activity").length() - 1).getJSONObject("data").getJSONObject("afterCounts").getInt("photos") == 4999, "Post-edit count is wrong");
        check(CaptureJournal.INSTANCE.read(context, owner, draft).getJSONArray("activity").toString().equals(changes), "Restart lost pending history");
        check(!CaptureJournal.INSTANCE.acknowledge(context, owner, draft, session, captured.getLong("revision")), "Stale handoff consumed activity");
        check(CaptureJournal.INSTANCE.acknowledge(context, owner, draft, session, changed.getLong("revision")), "Current handoff failed");
        JSONObject reopened = CaptureJournal.INSTANCE.save(context, identity, new JSONObject().put("activeLotNumber", 2), lots);
        check(reopened.getJSONArray("activity").length() == 1, "Acknowledged capture events replayed");
        CaptureJournal.INSTANCE.acknowledge(context, owner, draft, session, reopened.getLong("revision"));
    }
}
