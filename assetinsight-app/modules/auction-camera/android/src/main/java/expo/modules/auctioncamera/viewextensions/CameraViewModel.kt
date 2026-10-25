package expo.modules.auctioncamera.viewextensions

import android.app.Application
import android.content.Context
import android.net.Uri
import androidx.camera.core.ImageCapture
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import expo.modules.auctioncamera.CaptureMode
import expo.modules.auctioncamera.model.DeviceLimits

class CameraViewModel(application: Application) : AndroidViewModel(application) {

    companion object {
        private const val PREF_CAPTURE_MODE = "capture_mode"
    }

    val repository = LotRepository.getInstance(application)

    private val prefs = application.getSharedPreferences("camera_vm_state", Context.MODE_PRIVATE)

    private val _captureMode = MutableLiveData<CaptureMode?>(null)
    val captureMode: LiveData<CaptureMode?> = _captureMode

    val _currentLotNumber = MutableLiveData(1)
    val currentLotNumber: LiveData<Int> = _currentLotNumber

    private val _mainCount = MutableLiveData(0)
    val mainCount: LiveData<Int> = _mainCount

    private val _extraCount = MutableLiveData(0)
    val extraCount: LiveData<Int> = _extraCount

    private val _totalCount = MutableLiveData(0)
    val totalCount: LiveData<Int> = _totalCount

    private val _modeMismatch = SingleLiveEvent<Pair<LotMode, LotMode>>()
    val modeMismatch: LiveData<Pair<LotMode, LotMode>> = _modeMismatch

    private val _nextLotConfirm = SingleLiveEvent<Boolean>()
    val nextLotConfirm: LiveData<Boolean> = _nextLotConfirm

    private val _completedLots = MutableLiveData<List<LotPayload>>(emptyList())
    val completedLots: LiveData<List<LotPayload>> = _completedLots

    private val _lastCapturedUri = MutableLiveData<Uri?>()
    val lastCapturedUri: LiveData<Uri?> = _lastCapturedUri

    private val _deviceLimits = MutableLiveData<DeviceLimits?>()
    val deviceLimits: LiveData<DeviceLimits?> = _deviceLimits

    private val _lots = MutableLiveData<List<LotLegacy>>(emptyList())
    val lots: LiveData<List<LotLegacy>> = _lots

    private val _currentLotIndex = MutableLiveData(0)
    val currentLotIndex: LiveData<Int> = _currentLotIndex

    private val _activeLotLabel = MutableLiveData("Lot 1")
    val activeLotLabel: LiveData<String> = _activeLotLabel

    private val _activeLotPhotoCount = MutableLiveData(0)
    val activeLotPhotoCount: LiveData<Int> = _activeLotPhotoCount

    private val _currentLotPhotoCount = MutableLiveData(0)
    val currentLotPhotoCount: LiveData<Int> = _currentLotPhotoCount

    private val _currentLotUris = MutableLiveData<List<Uri>>(emptyList())
    val currentLotUris: LiveData<List<Uri>> = _currentLotUris

    private var viewingCompletedLotIndex: Int? = null
    private val lotNumberToCompletedIndices = mutableMapOf<Int, MutableList<Int>>()

    private val _flashMode = MutableLiveData<Int>(ImageCapture.FLASH_MODE_OFF)
    val flashMode: LiveData<Int> = _flashMode

    private val _viewedLotMode = MutableLiveData<CaptureMode?>(null)
    val viewedLotMode: LiveData<CaptureMode?> = _viewedLotMode
    private var activeLotNumber: Int = 1

    private val _proSettingsMap = mutableMapOf<Int, ProSettings>()  // key = lotNumber
    private val _currentProSettings = MutableLiveData(ProSettings())
    val currentProSettings: LiveData<ProSettings> = _currentProSettings

    private var pendingIsExtra = false
    private var pendingCaptureMode: CaptureMode? = null

    init {
        rebuildIndexMap()
        activeLotNumber = 1
        _currentLotNumber.value = 1
        val savedMode = prefs.getString(PREF_CAPTURE_MODE, null)
        if (savedMode != null) {
            val restored = runCatching { CaptureMode.valueOf(savedMode) }.getOrNull()
            if (restored != null) _captureMode.value = restored
        }
        // A rejected pending journal leaves an intentionally unloaded fixed session.
        // Its next Activity must reach configure/restore and report that error, not
        // fail while constructing the ViewModel before recovery can run.
        if (!repository.isStructureLocked || repository.completedLotCount > 0) refreshLotState()
    }

    fun refresh() { refreshLotState() }

    fun persistSessionForBackground() {
        repository.saveSessionWithActiveSync(_currentLotNumber.value ?: 1)
    }

    fun restoreSessionIfAvailable(): Boolean {
        val restoredLotNumber = repository.restoreSessionFromCache() ?: return false
        val lotNum = restoredLotNumber.coerceAtLeast(1)
        val activeMode = repository.getActiveBuilder()?.getMode()
            ?: getLotsForNumber(lotNum).firstOrNull()?.mode
            ?: LotMode.SINGLE_LOT
        val captureMode = activeMode.toCaptureMode()

        _currentLotNumber.value = lotNum
        activeLotNumber = lotNum
        _currentLotIndex.value = lotNum - 1
        _captureMode.value = captureMode
        saveCaptureMode(captureMode)
        rebuildIndexMap()
        refreshCompletedLots()
        refreshLotState()
        return true
    }

    fun loadFromPayload(json: String) {
        val activeIdx = repository.replaceData(json)
        val allLots = repository.getAllLots()
        if (activeIdx < 0) {
            if (allLots.isEmpty()) {
                val lotNum = 1
                repository.prepareLotForEditing(lotNum, LotMode.SINGLE_LOT)
                _currentLotNumber.value = lotNum
                activeLotNumber = lotNum
                _currentLotIndex.value = lotNum - 1
                _captureMode.value = CaptureMode.BUNDLE
                saveCaptureMode(CaptureMode.BUNDLE)
                refreshLotState()
            }
            return
        }

        val activeLotNum = try {
            val obj = org.json.JSONObject(json)
            obj.optInt("activeLotNumber", activeIdx + 1)
        } catch (_: Exception) {
            activeIdx + 1
        }

        val lotNum = activeLotNum.coerceIn(1, allLots.size.coerceAtLeast(1))
        val currentMode = getLotsForNumber(lotNum).firstOrNull()?.mode ?: LotMode.SINGLE_LOT
        repository.prepareLotForEditing(lotNum, currentMode)

        _currentLotNumber.value = lotNum
        activeLotNumber = lotNum
        _currentLotIndex.value = lotNum - 1

        val mode = getLotsForNumber(lotNum).firstOrNull()?.mode ?: LotMode.SINGLE_LOT
        val modeEnum = mode.toCaptureMode()
        _captureMode.value = modeEnum
        saveCaptureMode(modeEnum)

        refreshLotState()
    }

    fun setInitialLotNumber(lotNum: Int) {
        _currentLotNumber.value = lotNum
        activeLotNumber = lotNum
        _currentLotIndex.value = lotNum - 1
        val currentMode = getLotsForNumber(lotNum).firstOrNull()?.mode ?: LotMode.SINGLE_LOT
        repository.prepareLotForEditing(lotNum, currentMode)

        val mode = getLotsForNumber(lotNum).firstOrNull()?.mode ?: LotMode.SINGLE_LOT
        val modeEnum = mode.toCaptureMode()
        _captureMode.value = modeEnum
        saveCaptureMode(modeEnum)
        refreshLotState()
    }


    // ─────────────────────────────────────────────────────────────────────────
    // Misc
    // ─────────────────────────────────────────────────────────────────────────

    fun setDeviceLimits(l: DeviceLimits?) { _deviceLimits.value = l }

    fun checkModeChange(requestedMode: CaptureMode): Pair<LotMode, LotMode>? {
        val current = _captureMode.value ?: return null
        if (current != requestedMode && currentLotNumberHasMedia())
            return Pair(current.toLotMode(), requestedMode.toLotMode())
        return null
    }

    private val _currentLotMode = MutableLiveData<LotMode?>(null)
    val currentLotMode: LiveData<LotMode?> = _currentLotMode
    fun setLotMode(mode: LotMode) { _currentLotMode.value = mode }

    private val _currentEV = MutableLiveData(0f)
    val currentEV: LiveData<Float> = _currentEV
    fun setCurrentEV(ev: Float) { _currentEV.value = ev }

    private val _extensionMode =
        MutableLiveData<CameraViewExtensionMode>(CameraViewExtensionMode.Normal)
    val extensionMode: LiveData<CameraViewExtensionMode> = _extensionMode
    fun setExtensionMode(m: CameraViewExtensionMode) { _extensionMode.value = m }

    private val _isRecording = MutableLiveData(false)
    val isRecording: LiveData<Boolean> = _isRecording
    fun setRecording(v: Boolean) { _isRecording.value = v }

    private fun lotHasMedia() = (repository.getActiveBuilder()?.isEmpty == false)

    private fun currentLotNumberHasMedia(): Boolean {
        val lotNum = _currentLotNumber.value ?: 1

        val activeBuilder = repository.getActiveBuilder()
        if (activeBuilder != null && (activeBuilder.primaryCount > 0 || activeBuilder.extraCount > 0)) {
            if (lotNum == (_currentLotNumber.value ?: 1)) return true
        }
        val completedIndices = completedIndicesForLot(lotNum)
        return completedIndices.isNotEmpty()
    }

    private fun completedIndicesForLot(lotNum: Int): List<Int> =
        lotNumberToCompletedIndices[lotNum] ?: emptyList()

    private fun getLotsForNumber(lotNum: Int): List<LotPayload> {
        val all = repository.getAllLots()
        return all.filter { it.lotNumber == lotNum }
    }

    private fun urisForLotNumber(lotNum: Int): List<Uri> {
        val uriData = mutableListOf<Pair<Uri, Long>>()
        val seen    = mutableSetOf<String>()

        fun add(u: Uri, modelTs: Long) {
            if (!seen.add(u.toString())) return
            val finalTs = if (modelTs > 0) modelTs else {
                try {
                    if (u.scheme == "file") java.io.File(u.path ?: "").lastModified() else 0L
                } catch (e: Exception) { 0L }
            }
            uriData.add(u to finalTs)
        }

        getLotsForNumber(lotNum).forEach { lot ->
            lot.files.forEach      { add(Uri.parse(it.uri), it.timestamp) }
            lot.extraFiles.forEach { add(Uri.parse(it.uri), it.timestamp) }
            lot.videoFile?.let     { add(Uri.parse(it.uri), it.timestamp) }
        }

        if (viewingCompletedLotIndex == null && lotNum == (_currentLotNumber.value ?: 1)) {
            repository.getActiveBuilder()?.buildOrNull()?.let { lot ->
                lot.files.forEach      { add(Uri.parse(it.uri), it.timestamp) }
                lot.extraFiles.forEach { add(Uri.parse(it.uri), it.timestamp) }
                lot.videoFile?.let     { add(Uri.parse(it.uri), it.timestamp) }
            }
        }

        return uriData.sortedBy { it.second }.map { it.first }
    }


    private fun registerCompletedLot() {
        val lotNum = _currentLotNumber.value ?: 1
        val newIdx = repository.completedLotCount - 1
        lotNumberToCompletedIndices.getOrPut(lotNum) { mutableListOf() }.add(newIdx)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Capture mode — always persist so UI survives restart
    // ─────────────────────────────────────────────────────────────────────────

    fun setCaptureMode(mode: CaptureMode) {
        if (repository.isStructureLocked && repository.fixedMode(_currentLotNumber.value ?: 1)?.toCaptureMode() != mode) return
        _captureMode.value = mode
        saveCaptureMode(mode)
        val lotMode = mode.toLotMode()
        repository.updateExistingLotMode(_currentLotNumber.value ?: 1, lotMode)
    }

    fun requestCapture(requestedMode: CaptureMode, isExtra: Boolean = false): Boolean {
        if (repository.isStructureLocked) {
            val lotNum = _currentLotNumber.value ?: 1
            val mode = repository.fixedMode(lotNum) ?: return false
            if (repository.hasReachedFixedPhotoLimit(lotNum)) return false
            if (!isExtra && requestedMode != mode.toCaptureMode()) return false
            if (repository.getActiveBuilder() == null) repository.prepareLotForEditing(lotNum, mode)
            pendingIsExtra = isExtra
            pendingCaptureMode = mode.toCaptureMode()
            return true
        }
        pendingIsExtra = isExtra
        pendingCaptureMode = requestedMode
        val current = _captureMode.value

        if (isExtra) {
            return true
        }

        if (current == null) {
            _captureMode.value = requestedMode
            saveCaptureMode(requestedMode)
            if (requestedMode == CaptureMode.BUNDLE) ensureBundleLotOpen()
            val lotMode = requestedMode.toLotMode()
            repository.updateExistingLotMode(_currentLotNumber.value ?: 1, lotMode)
            return true
        }
        if (current == requestedMode) {
            if (requestedMode == CaptureMode.BUNDLE) ensureBundleLotOpen()
            val lotMode = requestedMode.toLotMode()
            repository.updateExistingLotMode(_currentLotNumber.value ?: 1, lotMode)
            return true
        }
        if (currentLotNumberHasMedia()) {
            _modeMismatch.value = Pair(current.toLotMode(), requestedMode.toLotMode())
            return false
        }
        _captureMode.value = requestedMode
        saveCaptureMode(requestedMode)
        val lotMode = requestedMode.toLotMode()
        if (requestedMode == CaptureMode.BUNDLE) {
            repository.cancelCurrentLot()
            ensureBundleLotOpen()
        }
        repository.updateExistingLotMode(_currentLotNumber.value ?: 1, lotMode)
        return true
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lot navigation
    // ─────────────────────────────────────────────────────────────────────────

    fun goToNextLot() {
        val currentNum = _currentLotNumber.value ?: 1
        if (!repository.canNavigateTo(currentNum + 1)) return
        // Finalize current
        repository.finaliseCurrentLot(currentNum)
        registerCompletedLot()
        rebuildIndexMap()

        val nextNum = currentNum + 1
        _currentLotNumber.value = nextNum
        if (nextNum > activeLotNumber) activeLotNumber = nextNum
        viewingCompletedLotIndex = null

        repository.prepareLotForEditing(nextNum, _captureMode.value?.toLotMode() ?: LotMode.SINGLE_LOT)
        if (_captureMode.value == CaptureMode.BUNDLE) {
            ensureBundleLotOpen()
        }
        refreshLotState()
    }

    fun confirmNextLot() {
        if (!repository.canNavigateTo((_currentLotNumber.value ?: 1) + 1)) return
        if (lotHasMedia()) {
            repository.finaliseCurrentLot(_currentLotNumber.value ?: 1)
            registerCompletedLot()
            rebuildIndexMap()
        }
        refreshCompletedLots()
        viewingCompletedLotIndex = null
        executeNextLot()
    }
    private fun executeNextLot() {
        val nextNum = (_currentLotNumber.value ?: 1) + 1
        if (!repository.canNavigateTo(nextNum)) return
        _currentLotNumber.value = nextNum
        activeLotNumber = nextNum
        viewingCompletedLotIndex = null

        repository.prepareLotForEditing(nextNum, _captureMode.value?.toLotMode() ?: LotMode.SINGLE_LOT)
        if (_captureMode.value == CaptureMode.BUNDLE) {
            ensureBundleLotOpen()
        }
        _currentLotPhotoCount.value = 0
        val newSettings = _proSettingsMap[nextNum] ?: ProSettings()
        _currentProSettings.value = newSettings
        refreshLotState()
    }

    fun hasProSettingsForLot(lotNum: Int): Boolean {
        return _proSettingsMap.containsKey(lotNum)
    }

    fun goToPrevLot() {
        val currentNum = _currentLotNumber.value ?: 1
        if (currentNum > 1) {
            // Finalize current
            repository.finaliseCurrentLot(currentNum)
            registerCompletedLot()
            rebuildIndexMap()

            val prevNum = currentNum - 1
            _currentLotNumber.value = prevNum
            viewingCompletedLotIndex = null

            repository.prepareLotForEditing(prevNum, _captureMode.value?.toLotMode() ?: LotMode.SINGLE_LOT)
            refreshLotState()
        }
    }

    private fun refreshLotViewForNumber(lotNum: Int) {
        val uris    = urisForLotNumber(lotNum)
        val allLots = repository.getAllLots()
        _currentLotNumber.value     = lotNum
        _activeLotLabel.value       = repository.lotLabel(lotNum)
        _currentLotPhotoCount.value = uris.size
        _currentLotUris.value       = uris

        var main = 0; var extra = 0
        getLotsForNumber(lotNum).forEach { lot ->
            main  += lot.files.size
            extra += lot.extraFiles.size
        }
        _mainCount.value  = main
        _extraCount.value = extra


        val hasAnyMedia = (main + extra) > 0

        _viewedLotMode.value = if (!hasAnyMedia) {
            null
        } else {
            val lotMode = getLotsForNumber(lotNum).firstOrNull()?.mode
            when (lotMode) {
                LotMode.SINGLE_LOT -> CaptureMode.BUNDLE
                LotMode.PER_ITEM   -> CaptureMode.ITEM
                LotMode.PER_PHOTO  -> CaptureMode.PHOTO
                null               -> null
            }
        }


        refreshTotalCount()
        val savedSettings = _proSettingsMap[lotNum] ?: ProSettings()
        _currentProSettings.value = savedSettings
    }

    fun getProSettingsForLot(lotNum: Int): ProSettings =
        _proSettingsMap[lotNum] ?: ProSettings()

    fun saveProSettingsForLot(lotNum: Int, settings: ProSettings) {
        _proSettingsMap[lotNum] = settings
        if (lotNum == _currentLotNumber.value) {
            _currentProSettings.value = settings
        }
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Photo / video captured
    // ─────────────────────────────────────────────────────────────────────────

    fun onPhotoCaptured(uri: Uri, focusBox: FocusBox? = null, ticketMode: CaptureMode? = null, ticketExtra: Boolean? = null) {
        _lastCapturedUri.value = uri
        val isExtra = ticketExtra ?: pendingIsExtra
        val viewingNum = viewingCompletedLotIndex
        val requestedMode = ticketMode ?: pendingCaptureMode ?: _captureMode.value ?: CaptureMode.PHOTO

        pendingIsExtra = false
        pendingCaptureMode = null

        if (repository.isStructureLocked) {
            val lotNum = _currentLotNumber.value ?: 1
            val lotMode = checkNotNull(repository.fixedMode(lotNum))
            if (repository.getActiveBuilder() == null) repository.prepareLotForEditing(lotNum, lotMode)
            if (isExtra) repository.addExtraPhoto(uri, lotMode)
            else repository.addPrimaryPhoto(uri, lotMode, focusBox)
            refreshCompletedLots()
            refreshLotState()
            return
        }

        // If we're capturing into a PAST lot, viewingNum won't be null
        if (viewingNum != null) {
            if (lotHasMedia()) {
                repository.finaliseCurrentLot(activeLotNumber)
                registerCompletedLot()
            }

            val lotMode = requestedMode.toLotMode()
            repository.startNewLot(lotMode)

            if (isExtra) {
                repository.addExtraPhoto(uri, lotMode)
            } else {
                repository.addPrimaryPhoto(uri, lotMode, focusBox)
            }

            repository.finaliseCurrentLot(viewingNum)
            registerCompletedLot()

            rebuildIndexMap()
            refreshCompletedLots()
            refreshLotViewForNumber(viewingNum)
            return
        }

        val currentMode = ticketMode ?: _captureMode.value

        if (currentMode == null) {
            val lotMode = if (isExtra) requestedMode.toLotMode() else LotMode.SINGLE_LOT

            if (repository.getActiveBuilder() == null) {
                repository.startNewLot(lotMode)
            }

            if (isExtra) {
                repository.addExtraPhoto(uri, lotMode)
            } else {
                repository.addPrimaryPhoto(uri, lotMode, focusBox)
            }

            refreshLotState()
            return
        }

        when (currentMode) {
            CaptureMode.BUNDLE -> {
                ensureBundleLotOpen()
                if (isExtra) {
                    repository.addExtraPhoto(uri, LotMode.SINGLE_LOT)
                } else {
                    repository.addPrimaryPhoto(uri, LotMode.SINGLE_LOT, focusBox)
                }
            }

            CaptureMode.ITEM -> {
                if (repository.getActiveBuilder() == null) {
                    repository.startNewLot(LotMode.PER_ITEM)
                }
                if (isExtra) {
                    repository.addExtraPhoto(uri, LotMode.PER_ITEM)
                } else {
                    repository.addPrimaryPhoto(uri, LotMode.PER_ITEM, focusBox)
                }
            }

            CaptureMode.PHOTO -> {
                val lotMode = LotMode.PER_PHOTO
                if (repository.getActiveBuilder() == null) {
                    repository.startNewLot(lotMode)
                }
                if (isExtra) {
                    repository.addExtraPhoto(uri, lotMode)
                } else {
                    repository.addPrimaryPhoto(uri, lotMode, focusBox)
                }
            }
        }
        refreshLotState()
    }

    fun onVideoRecorded(uri: Uri) {
        viewingCompletedLotIndex = null
        _isRecording.value = false
        val mode    = _captureMode.value ?: CaptureMode.BUNDLE
        val lotMode = when (mode) {
            CaptureMode.BUNDLE -> LotMode.SINGLE_LOT
            CaptureMode.ITEM   -> LotMode.PER_ITEM
            CaptureMode.PHOTO  -> LotMode.PER_PHOTO
        }

        if (repository.isStructureLocked && repository.getActiveBuilder() == null) {
            repository.prepareLotForEditing(_currentLotNumber.value ?: 1, lotMode)
        } else if (repository.getActiveBuilder() == null) {
            repository.startNewLot(lotMode)
        }
        repository.setVideo(uri)
        refreshCompletedLots()
        refreshLotState()
    }

    fun deleteMedia(uri: Uri, displayedLotNumber: Int? = null) {
        val targetLot = if (repository.isStructureLocked) displayedLotNumber ?: (_currentLotNumber.value ?: 1) else null
        val removedActive = repository.removeFileFromActiveLot(uri, targetLot)
        val removedCompleted = repository.removeFileFromCompletedLots(uri, targetLot)
        if (removedActive || removedCompleted) {
            rebuildIndexMap()
            refreshCompletedLots()
            refreshLotState()
        }
    }


    // ─────────────────────────────────────────────────────────────────────────
    // Index map — rebuilt from stored lotNumber on each lot payload
    // ─────────────────────────────────────────────────────────────────────────

    private fun rebuildIndexMap() {
        lotNumberToCompletedIndices.clear()
        repository.getAllLots().forEachIndexed { index, lot ->
            val lotNum = lot.lotNumber.takeIf { it > 0 } ?: (index + 1)
            lotNumberToCompletedIndices.getOrPut(lotNum) { mutableListOf() }.add(index)
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // State refresh
    // ─────────────────────────────────────────────────────────────────────────

    fun isViewingPastLot(): Boolean = viewingCompletedLotIndex != null

    fun refreshLotState() {
        val lotNum  = _currentLotNumber.value ?: 1
        if (repository.isStructureLocked) {
            val rows = repository.getEffectiveLots()
            // A gallery ViewModel may be created while a different fixed lot is active.
            val row = rows.getOrNull(lotNum - 1) ?: return
            _mainCount.value = row.files.size
            _extraCount.value = row.extraFiles.size
            _activeLotPhotoCount.value = row.files.size
            _activeLotLabel.value = repository.lotLabel(lotNum)
            _currentLotIndex.value = lotNum - 1
            val uris = row.files.map { Uri.parse(it.uri) } + row.extraFiles.map { Uri.parse(it.uri) } + listOfNotNull(row.videoFile?.uri?.let(Uri::parse))
            _currentLotPhotoCount.value = uris.size
            _currentLotUris.value = uris
            _lots.value = rows.map { LotLegacy(repository.lotLabel(it.lotNumber), it.files.size) }
            _captureMode.value = row.mode?.toCaptureMode()
            _viewedLotMode.value = row.mode?.toCaptureMode()
            refreshTotalCount()
            return
        }
        val allLots = repository.getAllLots()
        val builder = repository.getActiveBuilder()

        val activeMain  = if (viewingCompletedLotIndex == null) (builder?.primaryCount ?: 0) else 0
        val activeExtra = if (viewingCompletedLotIndex == null) (builder?.extraCount   ?: 0) else 0

        var completedMain  = 0
        var completedExtra = 0
        getLotsForNumber(lotNum).forEach { lot ->
            completedMain  += lot.files.size
            completedExtra += lot.extraFiles.size
        }

        _mainCount.value           = activeMain + completedMain
        _extraCount.value          = activeExtra + completedExtra
        _activeLotPhotoCount.value = activeMain
        _activeLotLabel.value      = "Lot $lotNum"

        _currentLotIndex.value = if (repository.completedLotCount > 0)
            repository.completedLotCount - 1 else 0

        val lotUris = urisForLotNumber(lotNum)
        _currentLotPhotoCount.value = lotUris.size
        _currentLotUris.value       = lotUris

        _lots.value = allLots.mapIndexed { i, p ->
            LotLegacy("Lot ${i + 1}", p.files.size)
        } + listOf(LotLegacy("Lot $lotNum", activeMain))

        val isViewingPast = viewingCompletedLotIndex != null
        if (isViewingPast) {
            val lotMode = getLotsForNumber(lotNum).firstOrNull()?.mode
            _viewedLotMode.value = when (lotMode) {
                LotMode.SINGLE_LOT -> CaptureMode.BUNDLE
                LotMode.PER_ITEM   -> CaptureMode.ITEM
                LotMode.PER_PHOTO  -> CaptureMode.PHOTO
                null               -> null
            }
        } else {
            val lotMode = getLotsForNumber(lotNum).firstOrNull()?.mode ?: builder?.getMode()
            if (lotMode != null) {
                val capMode = when (lotMode) {
                    LotMode.SINGLE_LOT -> CaptureMode.BUNDLE
                    LotMode.PER_ITEM   -> CaptureMode.ITEM
                    LotMode.PER_PHOTO  -> CaptureMode.PHOTO
                }
                if (_captureMode.value != capMode) {
                    _captureMode.value = capMode
                }
            }
            _viewedLotMode.postValue(_captureMode.value)
        }

        refreshTotalCount()
    }
    private fun refreshCompletedLots() {
        _completedLots.value = repository.getAllLots()
        refreshTotalCount()
    }

    private fun refreshTotalCount() {
        if (repository.isStructureLocked) {
            _totalCount.postValue(repository.getEffectiveLots().sumOf { it.files.size + it.extraFiles.size })
            return
        }
        var total = 0
        repository.getAllLots().forEach { lot ->
            total += lot.files.size
            total += lot.extraFiles.size
        }
        repository.getActiveBuilder()?.let {
            total += it.primaryCount + it.extraCount
        }
        _totalCount.postValue(total)
    }

    fun getDisplayedLotUris(): List<Uri> {
        val lotNum = viewingCompletedLotIndex ?: (_currentLotNumber.value ?: 1)
        if (repository.isStructureLocked) {
            val row = repository.getEffectiveLots().getOrNull(lotNum - 1) ?: return emptyList()
            return row.files.map { Uri.parse(it.uri) } + row.extraFiles.map { Uri.parse(it.uri) } + listOfNotNull(row.videoFile?.uri?.let(Uri::parse))
        }
        return urisForLotNumber(lotNum)
    }

    fun clearSession() {
        repository.clearLotsOnly()
        lotNumberToCompletedIndices.clear()
        activeLotNumber = 1
        _currentLotNumber.value = 1
        _captureMode.value = null
        _mainCount.value = 0
        _extraCount.value = 0
        _totalCount.value = 0
        _currentLotUris.value = emptyList()
        _activeLotPhotoCount.value = 0
        _currentLotPhotoCount.value = 0
        _lastCapturedUri.value = null
        viewingCompletedLotIndex = null
        _viewedLotMode.value = null
        prefs.edit().remove(PREF_CAPTURE_MODE).apply()
        clearAllProSettings()
    }

    fun getLotExistingMode(): CaptureMode? {
        val lotNum  = _currentLotNumber.value ?: 1
        repository.fixedMode(lotNum)?.let { return it.toCaptureMode() }
        val lot = getLotsForNumber(lotNum).firstOrNull { it.files.isNotEmpty() }
        if (lot != null) {
            return when (lot.mode) {
                LotMode.SINGLE_LOT -> CaptureMode.BUNDLE
                LotMode.PER_ITEM   -> CaptureMode.ITEM
                LotMode.PER_PHOTO  -> CaptureMode.PHOTO
                else               -> CaptureMode.BUNDLE
            }
        }

        val builder = repository.getActiveBuilder()
        if (builder != null && builder.primaryCount > 0) {
            return _captureMode.value
        }
        return null
    }


    private fun findNextEmptyLotNumber(startFrom: Int): Int {
        var lotNum = startFrom
        while (true) {
            val lots = getLotsForNumber(lotNum)
            val hasMedia = lots.any { it.files.isNotEmpty() || it.extraFiles.isNotEmpty() || it.videoFile != null }
            if (!hasMedia) {
                return lotNum
            }
            lotNum++
        }
    }

    private fun getNextNewLotNumber(): Int {
        val maxCompletedLotNum = repository.getAllLots().maxOfOrNull { it.lotNumber } ?: 0
        val maxLotNum = maxOf(activeLotNumber, maxCompletedLotNum)
        return maxLotNum + 1
    }

    fun handleNewLotFromLock(requestedMode: CaptureMode) {
        if (repository.isStructureLocked) return
        if (lotHasMedia()) {
            repository.finaliseCurrentLot(_currentLotNumber.value ?: 1)
            registerCompletedLot()
            refreshCompletedLots()
            rebuildIndexMap()
        }

        val targetLotNum = getNextNewLotNumber()

        _currentLotNumber.value = targetLotNum
        activeLotNumber = targetLotNum
        viewingCompletedLotIndex = null
        _captureMode.value = requestedMode
        saveCaptureMode(requestedMode)

        when (requestedMode) {
            CaptureMode.BUNDLE -> { repository.cancelCurrentLot(); ensureBundleLotOpen() }
            CaptureMode.ITEM   -> repository.cancelCurrentLot()
            CaptureMode.PHOTO  -> repository.cancelCurrentLot()
        }

        _mainCount.value            = 0
        _extraCount.value           = 0
        _currentLotPhotoCount.value = 0
        _currentLotUris.value       = emptyList()
        refreshLotState()
    }

    fun handleNewLotFromMismatch(requestedMode: CaptureMode) {
        if (repository.isStructureLocked) return
        if (lotHasMedia()) {
            repository.finaliseCurrentLot(_currentLotNumber.value ?: 1)
            registerCompletedLot()
            rebuildIndexMap()
        }
        val targetLotNum = getNextNewLotNumber()
        _currentLotNumber.value = targetLotNum
        activeLotNumber = targetLotNum
        viewingCompletedLotIndex = null
        refreshCompletedLots()
        _captureMode.value = requestedMode
        saveCaptureMode(requestedMode)
        when (requestedMode) {
            CaptureMode.BUNDLE -> { repository.cancelCurrentLot(); ensureBundleLotOpen() }
            CaptureMode.ITEM   -> repository.cancelCurrentLot()
            CaptureMode.PHOTO  -> repository.cancelCurrentLot()
        }
        _mainCount.value            = 0
        _extraCount.value           = 0
        _currentLotPhotoCount.value = 0
        _currentLotUris.value       = emptyList()
        refreshLotState()
    }

    private fun saveCaptureMode(mode: CaptureMode) {
        prefs.edit().putString(PREF_CAPTURE_MODE, mode.name).apply()
    }

    private fun ensureBundleLotOpen() {
        if (repository.getActiveBuilder() == null) {
            if (repository.isStructureLocked) repository.prepareLotForEditing(_currentLotNumber.value ?: 1)
            else repository.startNewLot(LotMode.SINGLE_LOT)
        }
    }

    private fun CaptureMode.toLotMode() = when (this) {
        CaptureMode.BUNDLE -> LotMode.SINGLE_LOT
        CaptureMode.ITEM   -> LotMode.PER_ITEM
        CaptureMode.PHOTO  -> LotMode.PER_PHOTO
    }

    fun saveProSettings(settings: ProSettings) {
        val lotNum = _currentLotNumber.value ?: 1
        _proSettingsMap[lotNum] = settings
        _currentProSettings.value = settings
    }

    fun updatePhotoUri(oldTempUri: Uri, newGalleryUri: Uri, w: Int = 0, h: Int = 0) {
        var updatedInActive = false
        repository.getActiveBuilder()?.let { builder ->
            val updatedPrimary = builder.replaceUri(oldTempUri, newGalleryUri, w, h)
            val updatedExtra = builder.replaceExtraUri(oldTempUri, newGalleryUri, w, h)
            updatedInActive = updatedPrimary || updatedExtra
        }

        if (!updatedInActive) {
            repository.replaceUriInCompletedLots(oldTempUri, newGalleryUri, w, h)
        }

        val currentUris = _currentLotUris.value?.toMutableList() ?: mutableListOf()
        val index = currentUris.indexOf(oldTempUri)
        if (index != -1) {
            currentUris[index] = newGalleryUri
            _currentLotUris.postValue(currentUris)

            if (_lastCapturedUri.value == oldTempUri) {
                _lastCapturedUri.postValue(newGalleryUri)
            }
        }
    }

    fun clearAllProSettings() {
        _proSettingsMap.clear()
        _currentProSettings.value = ProSettings()
    }

    fun finalisePendingExtraPhotos() {
        val builder = repository.getActiveBuilder()
        if (builder != null && builder.isEmpty == false) {
            val lotNum = _currentLotNumber.value ?: 1
            repository.finaliseCurrentLot(lotNum)
            registerCompletedLot()
            refreshCompletedLots()
            refreshLotState()
        }
    }
}
