#include "audio/AlsaAudio.h"
#include "control/ControlServer.h"
#include "dsp/DspEngine.h"

#include <array>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <exception>
#include <iostream>
#include <string>
#include <thread>

namespace {
constexpr int FRAMES = 256;

constexpr const char* DEFAULT_CONTROL_HOST = "127.0.0.1";
constexpr int DEFAULT_CONTROL_PORT = 3002;

volatile std::sig_atomic_t g_shutdownRequested = 0;

void handleSignal(int) {
    g_shutdownRequested = 1;
}

std::string envOr(const char* name, const std::string& fallback) {
    const char* const value = std::getenv(name);

    if (value == nullptr || *value == '\0') {
        return fallback;
    }

    return std::string(value);
}

int envPort(const char* name, int fallback) {
    const char* const value = std::getenv(name);

    if (value == nullptr || *value == '\0') {
        return fallback;
    }

    try {
        const int parsed = std::stoi(std::string(value));

        if (parsed > 0 && parsed <= 65535) {
            return parsed;
        }
    } catch (const std::exception&) {
        // Reported below.
    }

    std::cerr << "Ignoring invalid " << name << "='" << value << "'\n";
    return fallback;
}
} // namespace

int main() {
    AlsaAudio audio;
    DspEngine dsp;
    ControlServer control(dsp);

    // No sound card is not fatal: the agent still serves control, so the rig can
    // be configured and inspected on a machine with no audio.
    const bool audioLive = audio.open();

    if (!audioLive) {
        std::cerr << "No audio device available. "
                     "Running control only.\n";
    }

    const std::string host = envOr("MYASS_CONTROL_HOST", DEFAULT_CONTROL_HOST);
    const int port = envPort("MYASS_CONTROL_PORT", DEFAULT_CONTROL_PORT);

    if (!control.start(host, port)) {
        std::cerr << "Failed to start control server on "
                  << host << ':' << port << '\n';
        return 1;
    }

    std::signal(SIGINT, handleSignal);
    std::signal(SIGTERM, handleSignal);

    std::array<float, FRAMES> buffer{};

    std::cout << "MYASS audio loop "
              << (audioLive ? "started." : "skipped (no device).") << '\n';
    std::cout << "Control server listening on " << host << ':' << port << '\n';

    auto lastPrint = std::chrono::steady_clock::now();
    int lastStalls = 0;
    int exitCode = 0;

    while (g_shutdownRequested == 0) {
        if (!audioLive) {
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
            continue;
        }

        if (!audio.read(buffer.data(), FRAMES)) {
            exitCode = 1;
            break;
        }

        const float input = buffer[0];

        dsp.processBlock(buffer.data(), FRAMES);

        const float output = buffer[0];

        if (!audio.write(buffer.data(), FRAMES)) {
            exitCode = 1;
            break;
        }

        const auto now = std::chrono::steady_clock::now();

        if (now - lastPrint >= std::chrono::seconds(5)) {
            std::cout
                << "input: " << input
                << " output: " << output
                << '\n';

            // Only on change, so a device that dropped once does not repeat the
            // same warning every five seconds for the rest of the session.
            const int stalls = audio.stalls();

            if (stalls != lastStalls) {
                std::cout << "capture stalled " << stalls << " times\n";
                lastStalls = stalls;
            }

            lastPrint = now;
        }
    }

    std::cout << "Shutting down.\n";

    control.stop();
    audio.close();

    return exitCode;
}
