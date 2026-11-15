#include "control/ControlServer.h"

#include "control/Base64.h"
#include "effects/StandardEffects.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cstdint>
#include <exception>
#include <iomanip>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace {
constexpr int CLIENT_BACKLOG = 4;
constexpr std::size_t READ_CHUNK_BYTES = 8192;

// A transfer line carries base64 PCM, so it is much longer than a control
// line. 8192 samples encode to about 43.7 KB; 128 KB leaves room for the
// command prefix and a render reply of the same size.
constexpr std::size_t MAX_LINE_BYTES = 131072;
constexpr std::size_t TRANSFER_CHUNK_SAMPLES = 8192;

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

bool parseSize(const std::string& text, std::size_t& out) {
    if (text.empty() || text[0] == '-') {
        return false;
    }

    try {
        std::size_t consumed = 0;
        const unsigned long long value = std::stoull(text, &consumed);

        if (consumed != text.size()) {
            return false;
        }

        out = static_cast<std::size_t>(value);
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

// The click mode crosses the wire as a word rather than an enum number, so a
// human reading a state dump can tell what the metronome will do.
std::string clickName(ClickMode mode) {
    switch (mode) {
    case ClickMode::Off:
        return "off";
    case ClickMode::CountIn:
        return "countin";
    case ClickMode::CountInRecording:
        return "countin-record";
    }

    return "off";
}

bool parseClick(const std::string& text, ClickMode& out) {
    if (text == "off") {
        out = ClickMode::Off;
        return true;
    }

    if (text == "countin") {
        out = ClickMode::CountIn;
        return true;
    }

    if (text == "countin-record") {
        out = ClickMode::CountInRecording;
        return true;
    }

    return false;
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

    // The accept thread has stopped, so nothing can be staging a load or a
    // render chain now. Drop anything it left behind.
    resetSessions();
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
    // Every connection starts and ends with a clean staging area. A client
    // that vanishes mid-load must not leave a project or a render chain for
    // the next one to inherit.
    resetSessions();
    serveClient(clientFd);
    resetSessions();
}

void ControlServer::resetSessions() {
    staging_.clear();
    project_ = ProjectSession{};
    render_ = RenderSession{};
}

void ControlServer::serveClient(int clientFd) {
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
        const std::string layerText = optionValue(tokens, "layer");
        int layer = -1;

        if (!layerText.empty()) {
            if (!parseInt(layerText, layer)) {
                return {"error bad_value"};
            }

            const int layers = static_cast<int>(dsp_.loopState().layers.size());

            if (layer < 0 || layer >= layers) {
                return {"error bad_value"};
            }
        }

        if (sub == "RESET") {
            staging_.clear();
            return {"ok staging=0"};
        }

        if (sub == "COMMIT") {
            if (layer >= 0) {
                // Commit the staged board onto one layer's saved chain. The
                // live board is deliberately untouched: this is the paste
                // path, and it must not change what the instrument sounds
                // like right now.
                dsp_.setLoopChain(layer, std::move(staging_));
                staging_.clear();

                return {"ok chain=" + std::to_string(layer)};
            }

            dsp_.applyChain(std::move(staging_));
            staging_.clear();

            return {"ok slots=" + std::to_string(dsp_.snapshot().size())};
        }

        if (sub == "GET") {
            const auto chain =
                layer >= 0 ? dsp_.loopChainSnapshot(layer) : dsp_.snapshot();
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
        const std::string error = appendSlot(staging_, tokens, 1);

        if (!error.empty()) {
            return {error};
        }

        return {"ok slot=" + std::to_string(staging_.size() - 1)};
    }

    if (verb == "LOOP") {
        return handleLoop(tokens);
    }

    if (verb == "PROJECT") {
        return handleProject(tokens);
    }

    if (verb == "RENDER") {
        return handleRender(tokens);
    }

    return {"error unknown_command"};
}

std::string ControlServer::appendSlot(
    EffectChain& chain,
    const std::vector<std::string>& tokens,
    std::size_t indexToken
) {
    int index = 0;

    if (tokens.size() <= indexToken || !parseInt(tokens[indexToken], index)) {
        return "error bad_request";
    }

    // Slots must arrive in order, which catches a truncated chain early.
    if (index != static_cast<int>(chain.size())) {
        return "error out_of_order";
    }

    const std::string kind = optionValue(tokens, "kind");
    auto effect = createEffect(kind);

    if (effect == nullptr) {
        return "error unknown_effect";
    }

    const std::string enabled = optionValue(tokens, "enabled");

    if (enabled != "0" && enabled != "1") {
        return "error bad_request";
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
            return "error bad_value";
        }

        if (!effect->setParam(key, value)) {
            return "error unknown_param";
        }
    }

    chain.push_back(std::move(effect));
    return "";
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
            " rate=" + std::to_string(state.sampleRate) +
            " bpm=" + formatFloat(state.bpm) +
            " beats=" + std::to_string(state.beatsPerBar) +
            " bars=" + std::to_string(state.bars) +
            " click=" + clickName(state.click) +
            " loop=" + std::to_string(state.loopSamples) +
            " rev=" + std::to_string(state.revision) +
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
                " samples=" + std::to_string(layer.samples) +
                " pos=" + formatFloat(layer.position) +
                " waiting=" + (layer.waiting ? "1" : "0") +
                " countdown=" + formatFloat(layer.countdown) +
                " max=" + formatFloat(layer.maxSeconds) +
                " chain=" + (layer.chainCurrent ? "1" : "0") +
                " rev=" + std::to_string(layer.revision)
            );
        }

        replies.push_back("end");
        return replies;
    }

    if (action == "dump") {
        const int index = layerIndex();

        if (rejectIndex(index)) {
            return {"error bad_value"};
        }

        std::size_t offset = 0;
        std::size_t count = 0;

        if (tokens.size() < 5 || !parseSize(tokens[3], offset) ||
            !parseSize(tokens[4], count)) {
            return {"error bad_value"};
        }

        // One chunk per line keeps both directions bounded. A caller that
        // wants a whole layer asks repeatedly, which is also what keeps each
        // command inside the API's per-command timeout.
        if (count > TRANSFER_CHUNK_SAMPLES) {
            return {"error bad_value"};
        }

        const DspEngine::LayerDump dump = dsp_.dumpLayer(index, offset, count);

        if (dump.busy) {
            return {"error busy"};
        }

        return {
            "ok offset=" + std::to_string(dump.offset) +
            " count=" + std::to_string(dump.count) +
            " total=" + std::to_string(dump.total) +
            " data=" + encodePcm(dump.samples.data(), dump.samples.size())
        };
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

    if (action == "tempo") {
        float bpm = 0.0f;
        int beats = 4;

        if (tokens.size() < 3 || !parseFloat(tokens[2], bpm) ||
            !(bpm >= 40.0f && bpm <= 240.0f)) {
            return {"error bad_value"};
        }

        const std::string beatsText = optionValue(tokens, "beats");

        if (!beatsText.empty() &&
            (!parseInt(beatsText, beats) || beats != 4)) {
            // 4/4 is the only meter v1 supports; the field is on the wire so
            // 3/4 later is a validation change rather than a new command.
            return {"error bad_value"};
        }

        if (!dsp_.loopSetTempo(bpm, beats)) {
            return {"error busy"};
        }

        return {"ok bpm=" + formatFloat(bpm) +
                " beats=" + std::to_string(beats)};
    }

    if (action == "bars") {
        int bars = 0;

        if (tokens.size() < 3 || !parseInt(tokens[2], bars) || bars < 0 ||
            bars > 64) {
            return {"error bad_value"};
        }

        if (!dsp_.loopSetBars(bars)) {
            // Range is already validated, so a refusal is either a busy looper
            // or a bar count that does not fit in the 32 second buffer at this
            // tempo. The two deserve different answers.
            const LooperState state = dsp_.loopState();
            const double seconds =
                static_cast<double>(bars) * state.countdownSeconds;

            if (bars > 0 && seconds > static_cast<double>(state.maxSeconds)) {
                return {"error bad_value"};
            }

            return {"error busy"};
        }

        return {"ok bars=" + std::to_string(bars)};
    }

    if (action == "click") {
        ClickMode mode = ClickMode::Off;

        if (tokens.size() < 3 || !parseClick(tokens[2], mode)) {
            return {"error bad_value"};
        }

        dsp_.loopSetClickMode(mode);
        return {"ok click=" + clickName(mode)};
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

std::vector<std::string> ControlServer::handleProject(
    const std::vector<std::string>& tokens
) {
    if (tokens.size() < 3) {
        return {"error bad_request"};
    }

    const std::string& group = tokens[1];
    const std::string& sub = tokens[2];

    // Any malformed line inside an open load aborts it. A client that keeps
    // streaming after an error would otherwise be writing into a session whose
    // offsets and lengths no longer match what it thinks it is sending.
    const auto abort = [this](const std::string& error) {
        project_ = ProjectSession{};
        return std::vector<std::string>{error};
    };

    if (group == "LOAD") {
        if (sub == "BEGIN") {
            const LooperState state = dsp_.loopState();

            for (const auto& layer : state.layers) {
                if (layer.waiting || layer.recording) {
                    return {"error busy"};
                }
            }

            project_ = ProjectSession{};
            project_.open = true;
            project_.project.loop.layers.resize(state.layers.size());
            project_.started.assign(state.layers.size(), false);

            return {"ok staged=1"};
        }

        if (sub == "ABORT") {
            project_ = ProjectSession{};
            return {"ok aborted=1"};
        }

        if (!project_.open) {
            return {"error bad_request"};
        }

        const int layerCount =
            static_cast<int>(project_.project.loop.layers.size());

        if (sub == "LAYER") {
            int index = 0;

            if (tokens.size() < 5 || !parseInt(tokens[3], index) ||
                index < 0 || index >= layerCount) {
                return abort("error bad_value");
            }

            const std::string& op = tokens[4];
            LoopLoadLayer& layer =
                project_.project.loop.layers[static_cast<std::size_t>(index)];

            if (op == "BEGIN") {
                std::size_t samples = 0;

                if (tokens.size() < 6 || !parseSize(tokens[5], samples) ||
                    samples > dsp_.loopCapacitySamples()) {
                    return abort("error bad_value");
                }

                layer.data.assign(samples, 0.0f);
                layer.samples = samples;
                project_.started[static_cast<std::size_t>(index)] = true;

                return {
                    "ok layer=" + std::to_string(index) +
                    " samples=" + std::to_string(samples)
                };
            }

            if (!project_.started[static_cast<std::size_t>(index)]) {
                return abort("error bad_request");
            }

            if (op == "DATA") {
                std::size_t offset = 0;
                std::vector<float> chunk;

                if (tokens.size() < 7 || !parseSize(tokens[5], offset) ||
                    !decodePcm(tokens[6], chunk) ||
                    chunk.size() > TRANSFER_CHUNK_SAMPLES) {
                    return abort("error bad_value");
                }

                // A chunk may not run past the length the layer was begun
                // with, so a truncated transfer cannot leave a short layer
                // that would fail validation only at COMMIT.
                if (offset > layer.samples ||
                    chunk.size() > layer.samples - offset) {
                    return abort("error bad_value");
                }

                std::copy(
                    chunk.begin(),
                    chunk.end(),
                    layer.data.begin() + static_cast<std::ptrdiff_t>(offset)
                );

                return {
                    "ok offset=" + std::to_string(offset) +
                    " count=" + std::to_string(chunk.size())
                };
            }

            if (op == "META") {
                float level = 100.0f;
                const std::string levelText = optionValue(tokens, "level");

                if (!levelText.empty() &&
                    (!parseFloat(levelText, level) || level < 0.0f ||
                     level > 100.0f)) {
                    return abort("error bad_value");
                }

                const auto readFlag = [&](const char* key, bool& out) {
                    const std::string value = optionValue(tokens, key);

                    if (value.empty()) {
                        return true;
                    }

                    if (value != "0" && value != "1") {
                        return false;
                    }

                    out = value == "1";
                    return true;
                };

                bool muted = false;
                bool playing = false;
                bool truncated = false;

                if (!readFlag("muted", muted) ||
                    !readFlag("playing", playing) ||
                    !readFlag("truncated", truncated)) {
                    return abort("error bad_value");
                }

                // The looper stores a normalised level; the wire and the
                // project manifest both speak percent.
                layer.level = level / 100.0f;
                layer.muted = muted;
                layer.playing = playing;
                layer.truncated = truncated;

                return {"ok layer=" + std::to_string(index)};
            }

            return abort("error bad_request");
        }

        if (sub == "COMMIT") {
            LoopLoad& loop = project_.project.loop;

            const std::string bpmText = optionValue(tokens, "bpm");
            const std::string beatsText = optionValue(tokens, "beats");
            const std::string barsText = optionValue(tokens, "bars");
            const std::string loopText = optionValue(tokens, "loop");
            const std::string clickText = optionValue(tokens, "click");

            if ((!bpmText.empty() && !parseFloat(bpmText, loop.bpm)) ||
                (!beatsText.empty() &&
                 !parseInt(beatsText, loop.beatsPerBar)) ||
                (!barsText.empty() && !parseInt(barsText, loop.bars)) ||
                (!loopText.empty() &&
                 !parseSize(loopText, loop.loopSamples)) ||
                (!clickText.empty() &&
                 !parseClick(clickText, loop.click))) {
                return abort("error bad_value");
            }

            int loaded = 0;

            for (const auto& layer : loop.layers) {
                if (!layer.data.empty()) {
                    loaded += 1;
                }
            }

            // commitProject moves the buffers out of the staged project, so
            // the count is taken first.
            if (!dsp_.commitProject(project_.project)) {
                project_ = ProjectSession{};
                return {"error bad_value"};
            }

            project_ = ProjectSession{};
            return {"ok loaded=" + std::to_string(loaded)};
        }

        return abort("error bad_request");
    }

    if (group == "CHAIN") {
        if (!project_.open) {
            return {"error bad_request"};
        }

        if (sub == "RESET") {
            project_.chainStaging.clear();
            return {"ok staging=0"};
        }

        if (sub == "SLOT") {
            const std::string error =
                appendSlot(project_.chainStaging, tokens, 3);

            if (!error.empty()) {
                return abort(error);
            }

            return {
                "ok slot=" +
                std::to_string(project_.chainStaging.size() - 1)
            };
        }

        if (sub == "COMMIT") {
            int index = 0;

            if (tokens.size() < 4 || !parseInt(tokens[3], index) ||
                index < 0 ||
                index >=
                    static_cast<int>(project_.project.loop.layers.size())) {
                return abort("error bad_value");
            }

            project_.project.loop.layers[static_cast<std::size_t>(index)]
                .chain = std::move(project_.chainStaging);
            project_.chainStaging.clear();

            return {"ok chain=" + std::to_string(index)};
        }

        return abort("error bad_request");
    }

    if (group == "BOARD") {
        if (!project_.open) {
            return {"error bad_request"};
        }

        if (sub == "RESET") {
            project_.project.board.clear();
            project_.project.setsBoard = false;
            return {"ok staging=0"};
        }

        if (sub == "SLOT") {
            const std::string error =
                appendSlot(project_.project.board, tokens, 3);

            if (!error.empty()) {
                return abort(error);
            }

            return {
                "ok slot=" + std::to_string(project_.project.board.size() - 1)
            };
        }

        if (sub == "COMMIT") {
            // Staged now, applied by LOAD COMMIT: a board is part of the
            // project, not a live change.
            project_.project.setsBoard = true;
            return {
                "ok slots=" + std::to_string(project_.project.board.size())
            };
        }

        return abort("error bad_request");
    }

    return {"error bad_request"};
}

std::vector<std::string> ControlServer::handleRender(
    const std::vector<std::string>& tokens
) {
    if (tokens.size() < 2) {
        return {"error bad_request"};
    }

    const std::string& sub = tokens[1];

    const auto abort = [this](const std::string& error) {
        render_ = RenderSession{};
        return std::vector<std::string>{error};
    };

    if (sub == "BEGIN") {
        if (render_.open) {
            return {"error busy"};
        }

        const LooperState state = dsp_.loopState();

        for (const auto& layer : state.layers) {
            if (layer.waiting || layer.recording) {
                return {"error busy"};
            }
        }

        render_ = RenderSession{};
        render_.open = true;
        return {"ok render=1"};
    }

    if (sub == "END") {
        render_ = RenderSession{};
        return {"ok render=0"};
    }

    if (!render_.open) {
        return {"error bad_request"};
    }

    if (sub == "RESET") {
        render_.chain.clear();
        render_.ready = false;
        return {"ok staging=0"};
    }

    if (sub == "SLOT") {
        const std::string error = appendSlot(render_.chain, tokens, 2);

        if (!error.empty()) {
            return abort(error);
        }

        return {"ok slot=" + std::to_string(render_.chain.size() - 1)};
    }

    if (sub == "COMMIT") {
        render_.ready = true;
        return {"ok slots=" + std::to_string(render_.chain.size())};
    }

    if (sub == "DATA") {
        if (!render_.ready || tokens.size() < 3) {
            return {"error bad_request"};
        }

        std::vector<float> chunk;

        if (!decodePcm(tokens[2], chunk) ||
            chunk.size() > TRANSFER_CHUNK_SAMPLES) {
            return {"error bad_value"};
        }

        // The chain lives on the session, so a stateful effect (downsample,
        // for one) keeps its counter across DATA calls exactly as it would
        // across blocks in the live path.
        for (float& sample : chunk) {
            for (const auto& effect : render_.chain) {
                if (effect->enabled()) {
                    sample = effect->process(sample);
                }
            }
        }

        return {
            "ok count=" + std::to_string(chunk.size()) +
            " data=" + encodePcm(chunk.data(), chunk.size())
        };
    }

    return {"error bad_request"};
}
