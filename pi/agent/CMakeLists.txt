cmake_minimum_required(VERSION 3.22)

project(myass-agent VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(myass-agent
  src/main.cpp
  src/dsp/DspEngine.cpp
  src/effects/Distortion.cpp
)

target_include_directories(myass-agent PRIVATE src)
