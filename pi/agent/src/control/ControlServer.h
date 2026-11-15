#pragma once

#include "dsp/DspEngine.h"

#include <atomic>
#include <cstddef>
#include <string>
#include <thread>
#include <vector>

class ControlServer {
public:
    explicit ControlServer(DspEngine& dsp);
    ~ControlServer();

    ControlServer(const ControlServer&) = delete;
    ControlServer& operator=(const ControlServer&) = delete;

    bool start(const std::string& host, int port);
    void stop();

private:
    // A project load is one transaction spread over many lines. Everything is
    // assembled here and only touched by the DSP once COMMIT arrives, so a
    // client that disappears halfway cannot leave a half-loaded rig.
    struct ProjectSession {
        bool open = false;
        DspEngine::StagedProject project;
        std::vector<bool> started;
        EffectChain chainStaging;
    };

    // Rendering uses its own chain, never the live board, and keeps it across
    // DATA chunks so a stateful effect sees one continuous input.
    struct RenderSession {
        bool open = false;
        bool ready = false;
        EffectChain chain;
    };

    void acceptLoop();
    void handleClient(int clientFd);
    void serveClient(int clientFd);
    void resetSessions();

    std::vector<std::string> handleCommand(const std::string& line);
    std::vector<std::string> handleLoop(const std::vector<std::string>& tokens);
    std::vector<std::string> handleProject(
        const std::vector<std::string>& tokens
    );
    std::vector<std::string> handleRender(
        const std::vector<std::string>& tokens
    );

    // Shared by SLOT, PROJECT CHAIN SLOT, PROJECT BOARD SLOT and RENDER SLOT.
    // Returns an empty string on success, or the error word to send back.
    std::string appendSlot(
        EffectChain& chain,
        const std::vector<std::string>& tokens,
        std::size_t indexToken
    );

    DspEngine& dsp_;
    int listenFd_ = -1;
    std::atomic<bool> running_{false};
    std::thread acceptThread_;

    // Built up by SLOT lines and installed by CHAIN COMMIT.
    EffectChain staging_;

    ProjectSession project_;
    RenderSession render_;
};
