cmake_minimum_required(VERSION 3.13)
project(auctioncamera_mozjpeg C)

# MozJPEG 4.1.5 (https://github.com/mozilla/mozjpeg, tag v4.1.5) compiled directly: its own
# CMake build refuses add_subdirectory(). Only the library sources are built, without SIMD.
set(MOZJPEG_DIR ${CMAKE_CURRENT_SOURCE_DIR}/mozjpeg)
set(MOZJPEG_GENERATED ${CMAKE_CURRENT_BINARY_DIR}/mozjpeg-config)

# Values the upstream build would detect for an Android clang toolchain.
set(VERSION 4.1.5)
set(LIBJPEG_TURBO_VERSION_NUMBER 4001005)
set(COPYRIGHT_YEAR "1991-2023")
set(JPEG_LIB_VERSION 62)
set(BITS_IN_JSAMPLE 8)
set(MEM_SRCDST_SUPPORTED 1)
set(BUILD "auctioncamera")
set(INLINE "inline __attribute__((always_inline))")
set(THREAD_LOCAL "__thread")
set(SIZE_T ${CMAKE_SIZEOF_VOID_P})
set(HAVE_BUILTIN_CTZL 1)

configure_file(${MOZJPEG_DIR}/jconfig.h.in ${MOZJPEG_GENERATED}/jconfig.h)
configure_file(${MOZJPEG_DIR}/jconfigint.h.in ${MOZJPEG_GENERATED}/jconfigint.h)
configure_file(${MOZJPEG_DIR}/jversion.h.in ${MOZJPEG_GENERATED}/jversion.h)

set(MOZJPEG_SOURCES jcapimin.c jcapistd.c jccoefct.c jccolor.c jcdctmgr.c jchuff.c jcext.c
  jcicc.c jcinit.c jcmainct.c jcmarker.c jcmaster.c jcomapi.c jcparam.c
  jcphuff.c jcprepct.c jcsample.c jctrans.c jdapimin.c jdapistd.c jdatadst.c
  jdatasrc.c jdcoefct.c jdcolor.c jddctmgr.c jdhuff.c jdicc.c jdinput.c
  jdmainct.c jdmarker.c jdmaster.c jdmerge.c jdphuff.c jdpostct.c jdsample.c
  jdtrans.c jerror.c jfdctflt.c jfdctfst.c jfdctint.c jidctflt.c jidctfst.c
  jidctint.c jidctred.c jquant1.c jquant2.c jutils.c jmemmgr.c jmemnobs.c
  jsimd_none.c)
list(TRANSFORM MOZJPEG_SOURCES PREPEND ${MOZJPEG_DIR}/)

add_library(mozjpeg STATIC ${MOZJPEG_SOURCES})
set_target_properties(mozjpeg PROPERTIES POSITION_INDEPENDENT_CODE ON C_VISIBILITY_PRESET hidden)
target_include_directories(mozjpeg PUBLIC ${MOZJPEG_GENERATED} ${MOZJPEG_DIR})
target_compile_options(mozjpeg PRIVATE -O3)

add_library(auctioncamera_mozjpeg SHARED mozjpeg_jni.c)
target_link_libraries(auctioncamera_mozjpeg mozjpeg jnigraphics log)
# Android 15+ devices may use 16 KB memory pages.
target_link_options(auctioncamera_mozjpeg PRIVATE "-Wl,-z,max-page-size=16384")
