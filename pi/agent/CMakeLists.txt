cmake_minimum_required(VERSION 3.16)

project(myass-agent LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(PkgConfig REQUIRED)
pkg_check_modules(ALSA REQUIRED IMPORTED_TARGET alsa)

find_package(Threads REQUIRED)

# DSP and control transport, with no audio dependency, so the socket layer can
# be tested on a machine with no sound card.
add_library(myass-core
    src/dsp/DspEngine.cpp
    src/dsp/Looper.cpp
    src/effects/MixableEffect.cpp
    src/effects/StandardEffects.cpp
    src/control/Base64.cpp
    src/control/ControlServer.cpp
)

target_include_directories(myass-core PUBLIC src)

target_link_libraries(myass-core PUBLIC Threads::Threads)

add_executable(myass-agent
    src/main.cpp
    src/audio/AlsaAudio.cpp
)

target_link_libraries(myass-agent PRIVATE
    myass-core
    PkgConfig::ALSA
)

add_executable(myass-control-test
    test/control_test.cpp
)

target_link_libraries(myass-control-test PRIVATE myass-core)

enable_testing()

add_test(NAME control_test COMMAND myass-control-test)
