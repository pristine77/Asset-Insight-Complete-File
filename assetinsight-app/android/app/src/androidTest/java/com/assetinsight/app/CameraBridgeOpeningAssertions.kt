package com.assetinsight.app

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.BridgeReactContext
import expo.modules.auctioncamera.AuctionCameraModule
import expo.modules.auctioncamera.CameraPayloadStore
import expo.modules.auctioncamera.CaptureJournal
import expo.modules.auctioncamera.ui.camera.CameraViewActivity
import expo.modules.auctioncamera.viewextensions.LotRepository
import expo.modules.core.interfaces.ActivityProvider
import expo.modules.core.interfaces.InternalModule
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.ModulesProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.events.EventName
import expo.modules.kotlin.modules.Module
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Executes the production Expo module against an isolated synthetic host. */
object CameraBridgeOpeningAssertions {
    private class Receipt : Promise {
        val done = CountDownLatch(1)
        val settlements = AtomicInteger()
        var value: Any? = null
        var code: String? = null
        var failure: String? = null
        override fun resolve(result: Any?) { value = result; settlements.incrementAndGet(); done.countDown() }
        override fun reject(code: String, message: String?, cause: Throwable?) { this.code = code; failure = "$message: $cause"; settlements.incrementAndGet(); done.countDown() }
        fun await(seconds: Long = 5) { check(done.await(seconds, TimeUnit.SECONDS)) { "Native camera promise never settled" }; check(settlements.get() == 1) }
    }
    fun run(instrumentation: Instrumentation) {
        val context = instrumentation.targetContext
        var sentIntent: Intent? = null
        val launches = AtomicInteger()
        // This host records Android launches without delivering any result.
        // The actual camera is explicitly started below for the return test.
        lateinit var host: Activity
        instrumentation.runOnMainSync {
            host = object : Activity() {
                init { attachBaseContext(context) }
                override fun getFilesDir() = context.filesDir
                override fun startActivityForResult(intent: Intent, requestCode: Int) { sentIntent = intent; launches.incrementAndGet() }
            }
        }
        val provider = object : InternalModule, ActivityProvider {
            override fun getExportedInterfaces(): List<Class<*>> = listOf(ActivityProvider::class.java)
            override fun getCurrentActivity(): Activity = host
        }
        lateinit var react: ReactApplicationContext
        lateinit var app: AppContext
        lateinit var module: AuctionCameraModule
        instrumentation.runOnMainSync {
            react = BridgeReactContext(context)
            app = AppContext(object : ModulesProvider { override fun getModulesList(): List<Class<out Module>> = emptyList() },
                expo.modules.core.ModuleRegistry(listOf(provider), emptyList()), WeakReference(react))
            module = AuctionCameraModule()
            app.hostingRuntimeContext.registry.register(module)
        }
        val holder = checkNotNull(app.hostingRuntimeContext.registry.getModuleHolder(module))
        fun call(name: String, vararg args: Any?): Receipt = Receipt().also { receipt ->
            instrumentation.runOnMainSync { holder.call(name, arrayOf(*args), receipt) }
        }
        try {
            val cancelled = UUID.randomUUID().toString()
            call("cancelCameraLaunch", cancelled).also { it.await(); check(it.value == true) }
            call("openAuctionCamera", "[]", cancelled).also { it.await(); check(it.code == "E_CAMERA_BUSY") }
            check(launches.get() == 0) { "Cancelled queued invocation opened a camera" }
            // Real 20-second startup watchdog, not a substituted clock/timer.
            val neverStarted = call("openAuctionCamera", "[]", UUID.randomUUID().toString())
            neverStarted.await(24)
            check(neverStarted.code == "E_CAMERA_INTERRUPTED") { "Watchdog result was ${neverStarted.code}: ${neverStarted.failure}; launches=${launches.get()}" }
            check(launches.get() == 1)
            // Same module must be usable again; an old pending promise cannot
            // poison all future opens. Seeded journal comes from the prior test.
            val journal = checkNotNull(CaptureJournal.read(context, "isolated-camera-opening-20261023", "inspection-30-lots-324-photos"))
            val input = JSONObject().put("captureContext", JSONObject().put("ownerId", journal.getString("ownerId"))
                .put("draftId", journal.getString("draftId")).put("sessionId", journal.getString("sessionId")))
                .put("lots", journal.getJSONArray("lots")).put("activeLotIdx", 29).put("activeLotNumber", 30)
            val token = UUID.randomUUID().toString()
            val resumed = call("openAuctionCamera", input.toString(), token)
            val start = System.nanoTime()
            while (launches.get() < 2 && TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - start) < 5) Thread.sleep(20)
            check(launches.get() == 2)
            val activity = instrumentation.startActivitySync(Intent(checkNotNull(sentIntent)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as CameraViewActivity
            try {
                instrumentation.waitForIdleSync()
                call("cancelCameraLaunch", token).also { it.await(); check(it.value == false) { "Active inspection was cancelled" } }
                call("openAuctionCamera", "[]", UUID.randomUUID().toString()).also { it.await(); check(it.code == "E_CAMERA_BUSY") }
                check(resumed.settlements.get() == 0)
                instrumentation.runOnMainSync {
                    val repository = LotRepository.getInstance(context)
                    check(repository.getEffectiveLots().size == 30)
                    CameraPayloadStore.resultIntent(context, activity.intent, repository.exportCapture())
                    activity.finish() // Do not send this module an OnActivityResult.
                }
                resumed.await(6)
                check(resumed.code == null)
                val returned = JSONObject(resumed.value as String)
                check(returned.getJSONArray("lots").length() == 30)
                var photos = 0
                repeat(30) { photos += returned.getJSONArray("lots").getJSONObject(it).getJSONArray("files").length() }
                check(photos == 324)
                checkNotNull(CaptureJournal.read(context, journal.getString("ownerId"), journal.getString("draftId")))
            } finally { instrumentation.runOnMainSync { if (!activity.isFinishing) activity.finish() } }
        } finally { instrumentation.runOnMainSync { holder.post(EventName.MODULE_DESTROY) } }
    }
}
