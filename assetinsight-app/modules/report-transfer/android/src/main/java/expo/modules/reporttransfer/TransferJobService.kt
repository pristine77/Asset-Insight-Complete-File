package expo.modules.reporttransfer

import android.app.job.JobParameters
import android.app.job.JobService
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.work.ForegroundInfo
import androidx.work.WorkInfo
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class TransferJobService : JobService() {
    private data class Attempt(val id: String, val attemptId: String, val stopped: AtomicBoolean)
    private val attempts = ConcurrentHashMap<Int, Attempt>()
    override fun onStartJob(parameters: JobParameters): Boolean {
        val id = parameters.extras.getString("id") ?: return false
        val job = TransferStore.read(applicationContext, id) ?: return false
        val attempt = Attempt(id, UUID.randomUUID().toString(), AtomicBoolean(false)); attempts[parameters.jobId] = attempt
        if (Build.VERSION.SDK_INT >= 34) setNotification(parameters, job.getInt("schedulerId"), TransferNotifications.notification(this, job), JOB_END_NOTIFICATION_POLICY_DETACH)
        executor.execute {
            val outcome = TransferEngine.run(applicationContext, id, attempt.attemptId) { attempt.stopped.get() }
            if (attempts.remove(parameters.jobId, attempt) && !attempt.stopped.get()) jobFinished(parameters, outcome == TransferEngine.Outcome.RETRY)
        }
        return true
    }
    override fun onStopJob(parameters: JobParameters): Boolean {
        val attempt = attempts.remove(parameters.jobId) ?: return false
        attempt.stopped.set(true); TransferTransport.cancel(attempt.id)
        val reason = if (Build.VERSION.SDK_INT >= 31) parameters.stopReason else JobParameters.STOP_REASON_UNDEFINED
        val userStopped = reason == JobParameters.STOP_REASON_USER
        val description = when (reason) {
            JobParameters.STOP_REASON_CONSTRAINT_CONNECTIVITY -> "network_unavailable"
            JobParameters.STOP_REASON_UNDEFINED, JobParameters.STOP_REASON_CANCELLED_BY_APP -> "unknown"
            else -> "system_stop"
        }
        // Persist before returning to Android. This small journal write does not inspect originals.
        TransferEngine.interrupted(applicationContext, attempt.id, description, attempt.attemptId, userStopped)
        TransferCoordinator.scheduleEvents(applicationContext, attempt.id)
        return !userStopped && reason != JobParameters.STOP_REASON_CANCELLED_BY_APP
    }
    companion object { private val executor = Executors.newSingleThreadExecutor() }
}

class TransferWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result {
        val id = inputData.getString("id") ?: return Result.failure()
        val job = TransferStore.read(applicationContext, id) ?: return Result.success()
        // Only the pre-34 fallback creates a foreground service. API34+ uses UIDT.
        if (Build.VERSION.SDK_INT >= 34) return Result.success()
        val notification = TransferNotifications.notification(applicationContext, job)
        val foreground = if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(job.getInt("schedulerId"), notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            else ForegroundInfo(job.getInt("schedulerId"), notification)
        setForegroundAsync(foreground).get()
        return when (TransferEngine.run(applicationContext, id, this.id.toString()) { isStopped }) {
            TransferEngine.Outcome.DONE -> Result.success()
            TransferEngine.Outcome.RETRY -> Result.retry()
        }
    }
    override fun onStopped() {
        val id = inputData.getString("id") ?: return
        TransferTransport.cancel(id)
        val reason = when (stopReason) {
            WorkInfo.STOP_REASON_CONSTRAINT_CONNECTIVITY -> "network_unavailable"
            WorkInfo.STOP_REASON_UNKNOWN, WorkInfo.STOP_REASON_CANCELLED_BY_APP -> "unknown"
            else -> "system_stop"
        }
        TransferEngine.interrupted(applicationContext, id, reason, this.id.toString())
        TransferCoordinator.scheduleEvents(applicationContext, id)
    }
}

class TransferEventWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result {
        val id = inputData.getString("id") ?: return Result.failure()
        return if (TransferEngine.events(applicationContext, id) { isStopped } == TransferEngine.Outcome.RETRY) Result.retry() else Result.success()
    }
}
