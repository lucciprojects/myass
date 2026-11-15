#pragma once

#include "dsp/DspEngine.h"

#include <atomic>
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
    void acceptLoop();
    void handleClient(int clientFd);
    std::vector<std::string> handleCommand(const std::string& line);
    std::vector<std::string> handleLoop(const std::vector<std::string>& tokens);

    DspEngine& dsp_;
    int listenFd_ = -1;
    std::atomic<bool> running_{false};
    std::thread acceptThread_;

    // Built up by SLOT lines and installed by CHAIN COMMIT.
    EffectChain staging_;
};
