package expo.modules.reporttransfer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONObject
import java.util.concurrent.Executors

object TransferNotifications {
    private const val CHANNEL = "report-transfers"
    private fun manager(context: Context) = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    fun notification(context: Context, job: JSONObject): Notification {
        if (Build.VERSION.SDK_INT >= 26) manager(context).createNotificationChannel(NotificationChannel(CHANNEL, "Report uploads", NotificationManager.IMPORTANCE_LOW))
        val state = TransferStore.summary(job); val status = job.getString("status")
        val active = status in setOf("queued", "uploading", "waiting_network", "interrupted")
        val text = when {
            status == "accepted" -> "Report accepted. Processing continues on the server."
            job.optBoolean("finalizing") -> "Confirming report submission"
            status == "uploading" -> "Uploading ${state["completedFiles"]} of ${state["totalFiles"]} files"
            status == "queued" -> "Waiting to upload"
            else -> job.optString("message", "Open the app to review this report")
        }
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL) else Notification.Builder(context)
        builder.setSmallIcon(android.R.drawable.stat_sys_upload).setContentTitle(if (status == "accepted") "Report sent" else "Report upload")
            .setContentText(text).setOngoing(active).setOnlyAlertOnce(active).setAutoCancel(!active)
            .setVisibility(Notification.VISIBILITY_PRIVATE).setCategory(Notification.CATEGORY_PROGRESS)
        context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
            builder.setContentIntent(PendingIntent.getActivity(context, job.getInt("schedulerId"), it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        }
        if (state["canPause"] == true) {
            val pause = Intent(context, TransferPauseReceiver::class.java).putExtra("id", job.getString("id"))
            builder.addAction(Notification.Action.Builder(null, "Pause", PendingIntent.getBroadcast(context, job.getInt("schedulerId"), pause,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build())
        }
        if (status == "uploading" && !job.optBoolean("finalizing")) builder.setProgress(state["totalFiles"] as Int, state["completedFiles"] as Int, false)
        return builder.build()
    }
    fun show(context: Context, job: JSONObject) {
        val terminal = job.getString("status") in setOf("accepted", "paused", "auth_required", "needs_attention")
        // WorkManager removes its foreground notification after doWork returns.
        // A separate terminal ID keeps Sent/Pause visible on Android 24–33.
        val id = job.getInt("schedulerId") + if (Build.VERSION.SDK_INT < 34 && terminal) 1_000_000_000 else 0
        try { manager(context).notify(id, notification(context, job)) } catch (_: SecurityException) { /* In-app state still reports exact progress. */ }
    }
    fun cancel(context: Context, job: JSONObject) {
        manager(context).cancel(job.getInt("schedulerId")); manager(context).cancel(job.getInt("schedulerId") + 1_000_000_000)
    }
}

class TransferPauseReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra("id") ?: return
        if (!id.matches(Regex("[a-f0-9]{64}"))) return
        val pending = goAsync()
        executor.execute {
            try {
                val snapshot = TransferStore.read(context, id)?.getJSONObject("snapshot") ?: return@execute
                TransferCoordinator.pause(context, snapshot.getString("ownerId"), snapshot.getString("clientDraftId"))
            } catch (_: Exception) { /* A finalizing/owner-changed job cannot be paused by an old notification. */ }
            finally { pending.finish() }
        }
    }
    companion object { private val executor = Executors.newSingleThreadExecutor() }
}
