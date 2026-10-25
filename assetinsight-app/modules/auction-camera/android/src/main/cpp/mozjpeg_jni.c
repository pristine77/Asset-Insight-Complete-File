// JNI bridge: encodes an ARGB_8888 Bitmap with MozJPEG's default profile (progressive,
// trellis quantisation, optimised Huffman tables), 4:2:0 chroma, plus the sRGB ICC profile
// Android's own encoder embeds. Returns null on any failure so callers can fall back.
#include <jni.h>
#include <android/bitmap.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <limits.h>

#include "jpeglib.h"
#include "srgb_icc.h"

struct encoder_error {
    struct jpeg_error_mgr pub;
    jmp_buf jump;
};

/* Keep mutable codec state on the heap: automatic values changed after setjmp
 * are indeterminate after libjpeg's longjmp error path. */
struct encoder_state {
    struct jpeg_compress_struct cinfo;
    struct encoder_error error;
    unsigned char *output;
    unsigned long output_size;
};

static void destroy_encoder(struct encoder_state *state) {
    jpeg_destroy_compress(&state->cinfo);
    free(state->output);
    free(state);
}

static void on_encoder_error(j_common_ptr cinfo) {
    struct encoder_error *error = (struct encoder_error *) cinfo->err;
    longjmp(error->jump, 1);
}

JNIEXPORT jbyteArray JNICALL
Java_expo_modules_auctioncamera_compression_MozJpegEncoder_nativeEncode(
        JNIEnv *env, jclass clazz, jobject bitmap, jint quality) {
    (void) clazz;
    AndroidBitmapInfo info;
    if (AndroidBitmap_getInfo(env, bitmap, &info) != ANDROID_BITMAP_RESULT_SUCCESS ||
        info.format != ANDROID_BITMAP_FORMAT_RGBA_8888) {
        return NULL;
    }
    void *pixels = NULL;
    if (AndroidBitmap_lockPixels(env, bitmap, &pixels) != ANDROID_BITMAP_RESULT_SUCCESS) {
        return NULL;
    }

    struct encoder_state *state = calloc(1, sizeof(*state));
    if (state == NULL) {
        AndroidBitmap_unlockPixels(env, bitmap);
        return NULL;
    }
    state->cinfo.err = jpeg_std_error(&state->error.pub);
    state->error.pub.error_exit = on_encoder_error;
    if (setjmp(state->error.jump)) {
        destroy_encoder(state);
        AndroidBitmap_unlockPixels(env, bitmap);
        return NULL;
    }

    jpeg_create_compress(&state->cinfo);
    jpeg_mem_dest(&state->cinfo, &state->output, &state->output_size);
    state->cinfo.image_width = info.width;
    state->cinfo.image_height = info.height;
    state->cinfo.input_components = 4;
    state->cinfo.in_color_space = JCS_EXT_RGBX; // Android stores RGBA_8888 as R, G, B, A bytes.
    jpeg_set_defaults(&state->cinfo);
    jpeg_set_quality(&state->cinfo, quality, TRUE);
    jpeg_start_compress(&state->cinfo, TRUE);
    jpeg_write_icc_profile(&state->cinfo, SRGB_ICC_PROFILE, sizeof(SRGB_ICC_PROFILE));
    while (state->cinfo.next_scanline < state->cinfo.image_height) {
        JSAMPROW row = (JSAMPROW) ((unsigned char *) pixels + (size_t) state->cinfo.next_scanline * info.stride);
        jpeg_write_scanlines(&state->cinfo, &row, 1);
    }
    jpeg_finish_compress(&state->cinfo);
    AndroidBitmap_unlockPixels(env, bitmap);

    if (state->output_size > INT_MAX) {
        destroy_encoder(state);
        return NULL;
    }
    jbyteArray result = (*env)->NewByteArray(env, (jsize) state->output_size);
    if (result != NULL) {
        (*env)->SetByteArrayRegion(env, result, 0, (jsize) state->output_size, (const jbyte *) state->output);
    }
    destroy_encoder(state);
    return result;
}
