package expo.modules.auctioncamera.ui.camera

import expo.modules.auctioncamera.viewextensions.LotMode
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonDeserializationContext
import com.google.gson.JsonDeserializer
import com.google.gson.JsonElement
import com.google.gson.JsonPrimitive
import com.google.gson.JsonSerializationContext
import com.google.gson.JsonSerializer
import java.lang.reflect.Type

class LotModeAdapter : JsonSerializer<LotMode>, JsonDeserializer<LotMode> {

    override fun serialize(src: LotMode, typeOfSrc: Type, ctx: JsonSerializationContext): JsonElement =
        JsonPrimitive(src.apiKey)

    override fun deserialize(json: JsonElement, typeOfT: Type, ctx: JsonDeserializationContext): LotMode =
        LotMode.fromApiKey(json.asString)
}

object AppGson {
    val instance: Gson = GsonBuilder()
        .registerTypeAdapter(LotMode::class.java, LotModeAdapter())
        .serializeNulls()
        .create()
}