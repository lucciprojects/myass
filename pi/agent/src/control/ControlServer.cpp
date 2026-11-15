#include "control/ControlServer.h"

#include "effects/StandardEffects.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cstdint>
#include <exception>
#include <iomanip>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace {
constexpr int CLIENT_BACKLOG = 4;
constexpr std::size_t READ_CHUNK_BYTES = 512;
constexpr std::size_t MAX_LINE_BYTES = 4096;

std::string trim(const std::string& value) {
    const std::size_t begin = value.find_first_not_of(" \t\r\n");

    if (begin == std::string::npos) {
        return "";
    }

    const std::size_t end = value.find_last_not_of(" \t\r\n");
    return value.substr(begin, end - begin + 1);
}

std::vector<std::string> tokenize(const std::string& line) {
    std::istringstream stream(line);
    std::vector<std::string> tokens;
    std::string token;

    while (stream >> token) {
        tokens.push_back(token);
    }

    return tokens;
}

std::string optionValue(
    const std::vector<std::string>& tokens,
    const std::string& key
) {
    const std::string prefix = key + "=";

    for (const auto& token : tokens) {
        if (token.rfind(prefix, 0) == 0) {
            return trim(token.substr(prefix.size()));
        }
    }

    return "";
}

bool parseFloat(const std::string& text, float& out) {
    try {
        std::size_t consumed = 0;
        const float value = std::stof(text, &consumed);

        if (consumed != text.size()) {
            return false;
        }

        out = value;
        return true;
    } catch (const std::exception&) {
        return false;
    }
}

bool parseInt(const std::string& text, int& out) {
    try {
        std::size_t consumed = 0;
        const int value = std::stoi(text, &consumed);

        if (consumed != text.size()) {
            return false;
        }

        out = value;
        return true;
    } catch (const std::exception&) {
        return false;
    }
}

std::string formatFloat(float value) {
    std::ostringstream stream;
    stream << std::fixed << std::setprecision(4) << value;
    return stream.str();
}

bool sendLine(int fd, const std::string& line) {
    const std::string payload = line + "\n";
    std::size_t sent = 0;

    while (sent < payload.size()) {
        const ssize_t written = ::send(
            fd,
            payload.data() + sent,
            payload.size() - sent,
            MSG_NOSIGNAL
        );

        if (written <= 0) {
            return false;
        }

        sent += static_cast<std::size_t>(written);
    }

    return true;
}
} // namespace

ControlServer::ControlServer(DspEngine& dsp)
    : dsp_(dsp) {
}

ControlServer::~ControlServer() {
    stop();
}

bool ControlServer::start(const std::string& host, int port) {
    listenFd_ = ::socket(AF_INET, SOCK_STREAM, 0);

    if (listenFd_ < 0) {
        return false;
    }

    int reuse = 1;
    ::setsockopt(
        listenFd_,
        SOL_SOCKET,
        SO_REUSEADDR,
        &reuse,
        sizeof(reuse)
    );

    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<uint16_t>(port));

    if (host.empty() || host == "0.0.0.0") {
        address.sin_addr.s_addr = INADDR_ANY;
    } else if (::inet_pton(AF_INET, host.c_str(), &address.sin_addr) != 1) {
        ::close(listenFd_);
        listenFd_ = -1;
        return false;
    }

    if (::bind(
            listenFd_,
            reinterpret_cast<sockaddr*>(&address),
            sizeof(address)
        ) != 0) {
        ::close(listenFd_);
        listenFd_ = -1;
        return false;
    }

    if (::listen(listenFd_, CLIENT_BACKLOG) != 0) {
        ::close(listenFd_);
        listenFd_ = -1;
        return false;
    }

    running_.store(true);
    acceptThread_ = std::thread([this]() { acceptLoop(); });

    return true;
}

void ControlServer::stop() {
    if (!running_.exchange(false)) {
        return;
    }

    if (listenFd_ >= 0) {
        // Unblocks the accept() currently parked in acceptLoop().
        ::shutdown(listenFd_, SHUT_RDWR);
        ::close(listenFd_);
        listenFd_ = -1;
    }

    if (acceptThread_.joinable()) {
        acceptThread_.join();
    }
}

void ControlServer::acceptLoop() {
    while (running_.load()) {
        sockaddr_in client{};
        socklen_t clientSize = sizeof(client);

        const int clientFd = ::accept(
            listenFd_,
            reinterpret_cast<sockaddr*>(&client),
            &clientSize
        );

        if (clientFd < 0) {
            if (!running_.load()) {
                break;
            }

            continue;
        }

        handleClient(clientFd);
        ::close(clientFd);
    }
}

void ControlServer::handleClient(int clientFd) {
    std::string pending;
    char chunk[READ_CHUNK_BYTES];

    while (running_.load()) {
        const ssize_t received = ::recv(clientFd, chunk, sizeof(chunk), 0);

        if (received <= 0) {
            return;
        }

        pending.append(chunk, static_cast<std::size_t>(received));

        std::size_t newline = pending.find('\n');

        while (newline != std::string::npos) {
            const std::string line = pending.substr(0, newline);
            pending.erase(0, newline + 1);

            for (const auto& reply : handleCommand(line)) {
                if (!sendLine(clientFd, reply)) {
                    return;
                }
            }

            newline = pending.find('\n');
        }

        if (pending.size() > MAX_LINE_BYTES) {
            sendLine(clientFd, "error line_too_long");
            return;
        }
    }
}

std::vector<std::string> ControlServer::handleCommand(const std::string& rawLine) {
    const std::string line = trim(rawLine);

    if (line.empty()) {
        return {};
    }

    const std::vector<std::string> tokens = tokenize(line);
    const std::string& verb = tokens.front();
    const std::string sub = tokens.size() > 1 ? tokens[1] : "";

    if (verb == "PING") {
        return {"ok pong"};
    }

    if (verb == "CHAIN") {
        if (sub == "RESET") {
            staging_.clear();
            return {"ok staging=0"};
        }

        if (sub == "COMMIT") {
            dsp_.applyChain(std::move(staging_));
            staging_.clear();

            return {"ok slots=" + std::to_string(dsp_.snapshot().size())};
        }

        if (sub == "GET") {
            const auto chain = dsp_.snapshot();
            std::vector<std::string> replies;

            replies.push_back("ok slots=" + std::to_string(chain.size()));

            for (std::size_t index = 0; index < chain.size(); ++index) {
                const auto& slot = chain[index];

                std::string entry = "slot " + std::to_string(index) +
                    " kind=" + slot.kind +
                    " enabled=" + (slot.enabled ? "1" : "0");

                for (const auto& [key, value] : slot.params) {
                    entry += " " + key + "=" + formatFloat(value);
                }

                replies.push_back(entry);
            }

            replies.push_back("end");
            return replies;
        }

        return {"error bad_request"};
    }

    if (verb == "SLOT") {
        int index = 0;

        if (tokens.size() < 2 || !parseInt(tokens[1], index)) {
            return {"error bad_request"};
        }

        // Slots must arrive in order, which catches a truncated chain early.
        if (index != static_cast<int>(staging_.size())) {
            return {"error out_of_order"};
        }

        const std::string kind = optionValue(tokens, "kind");
        auto effect = createEffect(kind);

        if (effect == nullptr) {
            return {"error unknown_effect"};
        }

        const std::string enabled = optionValue(tokens, "enabled");

        if (enabled != "0" && enabled != "1") {
            return {"error bad_request"};
        }

        effect->setEnabled(enabled == "1");

        for (const auto& token : tokens) {
            const std::size_t equals = token.find('=');

            if (equals == std::string::npos || equals == 0) {
                continue;
            }

            const std::string key = token.substr(0, equals);

            // kind and enabled are addressed, not parameters.
            if (key == "kind" || key == "enabled") {
                continue;
            }

            float value = 0.0f;

            if (!parseFloat(trim(token.substr(equals + 1)), value)) {
                return {"error bad_value"};
            }

            if (!effect->setParam(key, value)) {
                return {"error unknown_param"};
            }
        }

        staging_.push_back(std::move(effect));
        return {"ok slot=" + std::to_string(index)};
    }

    if (verb == "LOOP") {
        return handleLoop(tokens);
    }

    return {"error unknown_command"};
}

std::vector<std::string> ControlServer::handleLoop(
    const std::vector<std::string>& tokens
) {
    if (tokens.size() < 2) {
        return {"error bad_request"};
    }

    const std::string& action = tokens[1];
    const int layers = dsp_.loopState().layers.size();

    // Everything except state and the no-argument clear takes a layer index,
    // and it is the second positional token rather than a key=value pair,
    // because there is only ever one of them.
    const auto layerIndex = [&]() -> int {
        if (tokens.size() < 3) {
            return -1;
        }

        int index = 0;

        if (!parseInt(tokens[2], index)) {
            return -1;
        }

        return index;
    };

    const auto rejectIndex = [&](int index) {
        return index < 0 || index >= layers;
    };

    if (action == "state") {
        const LooperState state = dsp_.loopState();

        std::vector<std::string> replies;
        replies.push_back(
            "ok layers=" + std::to_string(state.layers.size()) +
            " max=" + formatFloat(state.maxSeconds) +
            " countdown=" + formatFloat(state.countdownSeconds) +
            " transport=" + formatFloat(state.transportSeconds) +
            " paused=" + (state.paused ? "1" : "0")
        );

        for (const auto& layer : state.layers) {
            replies.push_back(
                "layer " + std::to_string(layer.index) +
                " playing=" + (layer.playing ? "1" : "0") +
                " recording=" + (layer.recording ? "1" : "0") +
                " muted=" + (layer.muted ? "1" : "0") +
                " truncated=" + (layer.truncated ? "1" : "0") +
                " level=" + formatFloat(layer.level) +
                " seconds=" + formatFloat(layer.seconds) +
                " pos=" + formatFloat(layer.position) +
                " waiting=" + (layer.waiting ? "1" : "0") +
                " countdown=" + formatFloat(layer.countdown) +
                " max=" + formatFloat(layer.maxSeconds) +
                " chain=" + (layer.chainCurrent ? "1" : "0")
            );
        }

        replies.push_back("end");
        return replies;
    }

    if (action == "clear") {
        // Bare clear wipes every layer, with an index it wipes one.
        if (tokens.size() < 3) {
            dsp_.loopClearAll();
            return {"ok cleared=all"};
        }

        const int index = layerIndex();

        if (rejectIndex(index)) {
            return {"error bad_value"};
        }

        dsp_.loopClear(index);
        return {"ok cleared=" + std::to_string(index)};
    }

    if (action == "undo") {
        dsp_.loopUndo();
        return {"ok cleared=last"};
    }

    if (action == "level") {
        const int index = layerIndex();
        float percent = 0.0f;

        if (rejectIndex(index) || tokens.size() < 4 ||
            !parseFloat(tokens[3], percent)) {
            return {"error bad_value"};
        }

        dsp_.loopSetLevel(index, percent);
        return {"ok level=" + std::to_string(index)};
    }

    if (action == "chain") {
        const int index = layerIndex();

        if (rejectIndex(index)) {
            return {"error bad_value"};
        }

        dsp_.loopPasteChain(index);
        return {"ok chain=" + std::to_string(index)};
    }

    if (action == "record" || action == "stop" || action == "play" ||
        action == "mute") {
        // A bare play drives the master transport: it freeze-pauses the whole
        // loop and resumes it again. Per-layer play below stays for the old
        // ring of per-row buttons.
        if (action == "play" && tokens.size() < 3) {
            dsp_.loopTogglePause();
            return {"ok play=all"};
        }

        const int index = layerIndex();

        if (rejectIndex(index)) {
            return {"error bad_value"};
        }

        if (action == "record") {
            // Default is the global cap; only an explicit max is validated.
            // The looper itself clamps, so the floor is enforced here rather
            // than silently recording a 0-second take.
            float maxSeconds = dsp_.loopMaxSeconds();
            const std::string maxText = optionValue(tokens, "max");

            if (!maxText.empty()) {
                if (!parseFloat(maxText, maxSeconds) || !(maxSeconds > 0.0f)) {
                    return {"error bad_value"};
                }
            }

            dsp_.loopRecord(index, maxSeconds);
        } else if (action == "stop") {
            dsp_.loopStop(index);
        } else if (action == "play") {
            dsp_.loopTogglePlay(index);
        } else {
            dsp_.loopToggleMute(index);
        }

        return {"ok " + action + "=" + std::to_string(index)};
    }

    return {"error bad_request"};
}
