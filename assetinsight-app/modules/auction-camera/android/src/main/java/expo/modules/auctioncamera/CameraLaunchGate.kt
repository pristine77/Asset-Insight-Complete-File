package expo.modules.auctioncamera

import java.util.UUID

/** AsyncFunction opens and main-thread activity results must transfer one identity. */
class CameraLaunchGate<T> {
    class Claim<T> internal constructor(val receiver: T, val handoffId: String, val requestCode: Int)
    private val lock = Any()
    private var pending: Claim<T>? = null
    companion object { private val sequence = java.util.concurrent.atomic.AtomicInteger() }
    private val cancelled = LinkedHashSet<String>()

    fun claim(receiver: T, handoffId: String = UUID.randomUUID().toString()): Claim<T>? = synchronized(lock) {
        if (pending != null || cancelled.contains(handoffId)) null
        else Claim(receiver, handoffId, 0xA000 + (sequence.incrementAndGet() % 0x1000)).also { pending = it }
    }

    fun peek(): Claim<T>? = synchronized(lock) { pending }

    // Fence a cancelled request even when its async bridge invocation arrives late.
    fun cancelBeforeStart(id: String) = synchronized(lock) {
        cancelled.add(id)
        if (cancelled.size > 128) cancelled.remove(cancelled.first())
    }

    fun detach(): Claim<T>? = synchronized(lock) {
        pending.also { pending = null }
    }

    /** A failed old launch must never clear a subsequent camera's pending result. */
    fun release(claim: Claim<T>): Boolean = synchronized(lock) {
        if (pending !== claim) false else {
            pending = null
            true
        }
    }
}
