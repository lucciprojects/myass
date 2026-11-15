// Exercises the control socket end to end without touching ALSA, so the chain
// transaction can be verified on a machine with no sound card.

#include "control/ControlServer.h"
#include "dsp/DspEngine.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

namespace {
constexpr const char* HOST = "127.0.0.1";
constexpr int PORT = 39999;

int failures = 0;

void check(const std::string& label, const std::string& actual, const std::string& expected) {
    // Flushed per line so an abort still shows which assertions ran.
    if (actual == expected) {
        std::cout << "  ok   " << label << std::endl;
        return;
    }

    failures += 1;
    std::cout << "  FAIL " << label
              << "\n       expected: " << expected
              << "\n       actual:   " << actual << std::endl;
}

void checkTrue(const std::string& label, bool condition) {
    check(label, condition ? "true" : "false", "true");
}

int connectToAgent() {
    const int fd = ::socket(AF_INET, SOCK_STREAM, 0);

    if (fd < 0) {
        return -1;
    }

    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(PORT);

    if (::inet_pton(AF_INET, HOST, &address.sin_addr) != 1) {
        ::close(fd);
        return -1;
    }

    if (::connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) {
        ::close(fd);
        return -1;
    }

    return fd;
}

std::string readLine(int fd) {
    std::string line;
    char byte = 0;

    while (::recv(fd, &byte, 1, 0) == 1) {
        if (byte == '\n') {
            return line;
        }

        line += byte;
    }

    return line;
}

std::string sendAndRead(int fd, const std::string& command) {
    const std::string payload = command + "\n";

    if (::send(fd, payload.data(), payload.size(), 0) !=
        static_cast<ssize_t>(payload.size())) {
        return "<send failed>";
    }

    return readLine(fd);
}

struct Timing {
    double worst = 0.0;
    double total = 0.0;
    long blocks = 0;
};

// Drives processBlock the way the audio thread does and records how long the
// worst block took, so the per block cost stays visible as the chain grows.
Timing measureBlocks(DspEngine& dsp, int blocks) {
    Timing timing;
    std::array<float, 256> block;

    for (int i = 0; i < blocks; ++i) {
        std::fill(block.begin(), block.end(), 0.5f);

        const auto start = std::chrono::steady_clock::now();
        dsp.processBlock(block.data(), static_cast<int>(block.size()));
        const auto end = std::chrono::steady_clock::now();

        const double micros =
            std::chrono::duration<double, std::micro>(end - start).count();

        if (micros > timing.worst) {
            timing.worst = micros;
        }

        timing.total += micros;
        timing.blocks += 1;
    }

    return timing;
}

struct LoopStateRead {
    std::string header;
    std::vector<std::string> layers;
};

// Reads a whole LOOP state reply up to its terminator. Counting the layer
// lines by hand at each call site is how the reply gets miscounted and the
// next read blocks forever waiting for a line that was never sent.
LoopStateRead readLoopState(int fd) {
    LoopStateRead result;
    result.header = sendAndRead(fd, "LOOP state");

    std::string line;

    // The empty check matters as much as the terminator: if the socket closed
    // early, readLine returns "" forever and the loop would spin.
    while ((line = readLine(fd)) != "end" && !line.empty()) {
        result.layers.push_back(line);
    }

    return result;
}

// Pulls "key=" out of a layer line, so assertions read against the value
// rather than against a hand-typed substring of the whole line.
std::string field(const std::string& line, const std::string& key) {
    const std::string prefix = key + "=";
    const std::size_t at = line.find(prefix);

    if (at == std::string::npos) {
        return "";
    }

    const std::size_t start = at + prefix.size();
    const std::size_t end = line.find(' ', start);

    return end == std::string::npos
        ? line.substr(start)
        : line.substr(start, end - start);
}

// Runs silence until the playhead is back at the top of its loop. Every
// offset-sensitive assertion needs this, otherwise it depends on wherever the
// previous assertion happened to leave the position.
//
// One frame at a time, deliberately. Feeding a whole block only works if the
// block size is not a multiple of the loop length: 64 frames against an 8 frame
// loop puts the playhead right back where it started, and this spins to the
// guard instead of syncing.
void syncToTop(DspEngine& dsp, int layerIndex) {
    for (int guard = 0; guard < 1000000; ++guard) {
        if (dsp.loopState().layers[layerIndex].position <= 1e-9f) {
            return;
        }

        std::array<float, 1> frame{};
        dsp.processBlock(frame.data(), 1);
    }
}
} // namespace

int main() {
    DspEngine dsp;
    ControlServer server(dsp);

    if (!server.start(HOST, PORT)) {
        std::cerr << "could not start control server on " << HOST << ':' << PORT << '\n';
        return 1;
    }

    const int fd = connectToAgent();

    if (fd < 0) {
        std::cerr << "could not connect to control server\n";
        server.stop();
        return 1;
    }

    std::cout << "control protocol\n";

    check("ping", sendAndRead(fd, "PING"), "ok pong");
    check("unknown command", sendAndRead(fd, "WAT"), "error unknown_command");
    check(
        "bad chain subcommand",
        sendAndRead(fd, "CHAIN WAT"),
        "error bad_request"
    );

    // Stage two slots, then reject a bad one. The live chain must be
    // untouched until COMMIT.
    check("reset", sendAndRead(fd, "CHAIN RESET"), "ok staging=0");
    check(
        "slot 0 overdrive",
        sendAndRead(fd, "SLOT 0 kind=overdrive enabled=1 drive=6.5000 mix=85.0000"),
        "ok slot=0"
    );
    check(
        "slot 1 bitcrush",
        sendAndRead(fd, "SLOT 1 kind=bitcrush enabled=1 levels=12.0000 mix=100.0000"),
        "ok slot=1"
    );
    check(
        "out of order slot",
        sendAndRead(fd, "SLOT 9 kind=gain enabled=1"),
        "error out_of_order"
    );
    check(
        "unknown effect",
        sendAndRead(fd, "SLOT 2 kind=nope enabled=1"),
        "error unknown_effect"
    );
    check(
        "unknown param",
        sendAndRead(fd, "SLOT 2 kind=gain enabled=1 bogus=1.0000"),
        "error unknown_param"
    );
    check(
        "non numeric param",
        sendAndRead(fd, "SLOT 2 kind=gain enabled=1 gain=abc"),
        "error bad_value"
    );

    checkTrue("chain empty before commit", dsp.snapshot().empty());
    check("commit", sendAndRead(fd, "CHAIN COMMIT"), "ok slots=2");

    const auto chain = dsp.snapshot();
    checkTrue("two slots live", chain.size() == 2);

    if (chain.size() == 2) {
        checkTrue("first kind is overdrive", chain[0].kind == "overdrive");
        checkTrue("second kind is bitcrush", chain[1].kind == "bitcrush");
    }

    // Params survive the round trip, not just the slot identity.
    check(
        "snapshot read back",
        sendAndRead(fd, "CHAIN GET"),
        "ok slots=2"
    );
    check(
        "slot 0 echoed",
        readLine(fd),
        "slot 0 kind=overdrive enabled=1 drive=6.5000 mix=85.0000"
    );
    check(
        "slot 1 echoed",
        readLine(fd),
        "slot 1 kind=bitcrush enabled=1 levels=12.0000 mix=100.0000"
    );
    check("terminator", readLine(fd), "end");

    // The chain must actually change samples.
    std::vector<float> block(4, 0.5f);
    dsp.processBlock(block.data(), 4);

    // Overdrive's mix applies first, then bitcrush sees the already-mixed
    // signal. Getting this backwards is exactly the kind of chain-order bug
    // the assertion exists to catch.
    const float driven = 0.5f + (std::tanh(0.5f * 6.5f) - 0.5f) * 0.85f;
    const float expected = std::round(driven * 12.0f) / 12.0f;

    checkTrue(
        "processed block is wet then crushed",
        std::fabs(block[0] - expected) < 1e-5f
    );

    // A disabled slot is bypassed entirely.
    check("reset again", sendAndRead(fd, "CHAIN RESET"), "ok staging=0");
    check(
        "disabled overdrive",
        sendAndRead(fd, "SLOT 0 kind=overdrive enabled=0 drive=20.0000 mix=100.0000"),
        "ok slot=0"
    );
    check("commit disabled", sendAndRead(fd, "CHAIN COMMIT"), "ok slots=1");

    std::vector<float> dry(4, 0.5f);
    dsp.processBlock(dry.data(), 4);
    checkTrue("disabled effect is bypassed", std::fabs(dry[0] - 0.5f) < 1e-6f);

    // An empty chain is a clean passthrough.
    check("reset empty", sendAndRead(fd, "CHAIN RESET"), "ok staging=0");
    check("commit empty", sendAndRead(fd, "CHAIN COMMIT"), "ok slots=0");

    std::vector<float> clean(4, 0.5f);
    dsp.processBlock(clean.data(), 4);
    checkTrue("empty chain passes through", std::fabs(clean[0] - 0.5f) < 1e-6f);

    // ---- audio path budget ----

    // Guards the thing that actually matters: that the per block cost of
    // processBlock leaves generous headroom in the 5333us an ALSA period
    // allows at 48kHz. A slow machine or a longer chain should still have
    // room to spare.
    check("reset for timing", sendAndRead(fd, "CHAIN RESET"), "ok staging=0");

    // Params must match the kind: sending levels to an overdrive is correctly
    // rejected, so each alternating slot gets only the keys it accepts.
    for (int i = 0; i < 4; ++i) {
        const std::string even =
            "SLOT " + std::to_string(i) +
            " kind=overdrive enabled=1 drive=4.0000 mix=80.0000";
        const std::string odd =
            "SLOT " + std::to_string(i) +
            " kind=bitcrush enabled=1 levels=16.0000 mix=80.0000";

        const std::string reply = sendAndRead(fd, i % 2 == 0 ? even : odd);
        check("timing slot staged", reply, "ok slot=" + std::to_string(i));
    }

    check("commit for timing", sendAndRead(fd, "CHAIN COMMIT"), "ok slots=4");

    const Timing timing = measureBlocks(dsp, 20000);

    // The mean is the figure that matters. The worst case on a general
    // purpose OS is dominated by the measurement thread being descheduled,
    // which is orders of magnitude larger than the DSP itself.
    std::cout << "  info 4 effect block: mean "
              << (timing.total / timing.blocks)
              << "us mean, " << timing.worst
              << "us worst, of a 5333us period" << std::endl;

    checkTrue(
        "mean block leaves 90 percent of the period free",
        timing.total / timing.blocks < 533.0
    );

    // ---- looper ----

    std::cout << "looper" << std::endl;

    // Start from a clean chain, otherwise the four effects left over from the
    // timing section distort the test impulses and the assertions below stop
    // being about the looper.
    check("clear chain for looper", sendAndRead(fd, "CHAIN RESET"), "ok staging=0");
    check("commit clean", sendAndRead(fd, "CHAIN COMMIT"), "ok slots=0");
    check("clear all layers", sendAndRead(fd, "LOOP clear"), "ok cleared=all");

    // Eight frames per block, with a single impulse at index 3. A loop of
    // exactly 8 frames then returns that impulse at a predictable place, which
    // a sine could not.
    constexpr int LOOP_FRAMES = 8;
    constexpr int IMPULSE_AT = 3;

    // Three seconds at the default 48kHz rate. The countdown lives in the
    // config, so the test's job is to cross it, not to know it by heart.
    constexpr std::size_t COUNTDOWN_FRAMES = 48000 * 3;

    const auto feed = [&](float value) {
        std::array<float, LOOP_FRAMES> block{};
        block[IMPULSE_AT] = value;
        dsp.processBlock(block.data(), static_cast<int>(block.size()));
        return block;
    };

    // Advances the shared clock by whole blocks. The transport counts samples,
    // not blocks, so the block size is irrelevant to the assertions.
    const auto advance = [&](std::size_t frames) {
        std::array<float, 256> block{};
        std::size_t left = frames;

        while (left > 0) {
            const int n = static_cast<int>(
                std::min<std::size_t>(block.size(), left));
            dsp.processBlock(block.data(), n);
            left -= static_cast<std::size_t>(n);
        }
    };

    // ---- arming, countdown, and the boot take ----

    // Crossing the countdown flips an arm into a take. Verified on a throwaway
    // layer so the take under test below can begin its very first sample on
    // the first frame of its own feed block.
    check("record layer 1 for crossing", sendAndRead(fd, "LOOP record 1"), "ok record=1");
    advance(COUNTDOWN_FRAMES + 1);

    {
        const LoopStateRead running = readLoopState(fd);
        check("crossing begins the take", field(running.layers[1], "recording"), "1");
        check("crossing clears the wait", field(running.layers[1], "waiting"), "0");
    }

    check("clear the crossing take", sendAndRead(fd, "LOOP clear 1"), "ok cleared=1");

    // Arming does not start a take: it schedules one after the countdown, so
    // the player can count themselves in. The state must say so.
    check("record layer 0", sendAndRead(fd, "LOOP record 0"), "ok record=0");

    {
        const LoopStateRead armed = readLoopState(fd);
        check("armed layer is waiting", field(armed.layers[0], "waiting"), "1");
        check("armed layer not yet recording", field(armed.layers[0], "recording"), "0");
        check("countdown at full", field(armed.layers[0], "countdown"), "3.0000");
        check("armed layer default max", field(armed.layers[0], "max"), "16.0000");
        check("armed layer captured the live chain", field(armed.layers[0], "chain"), "1");
    }

    // 1000 frames in, the countdown has moved but the take has not started.
    advance(1000);

    {
        const LoopStateRead tick = readLoopState(fd);
        check("countdown has moved", field(tick.layers[0], "countdown"), "2.9792");
        check("still waiting", field(tick.layers[0], "waiting"), "1");
    }

    // Bring the clock to the take's first frame without crossing it: the next
    // block (the feed below) is where clock meets startAt, so the take begins
    // on that block's first sample and the impulse lands at the same offset it
    // was recorded at.
    advance(COUNTDOWN_FRAMES - 1000);

    // While a first take is recording, the layer is not playing, so the loop
    // contributes nothing and the output is the input untouched.
    const auto recording = feed(1.0f);
    checkTrue(
        "recording layer adds nothing to the output",
        std::fabs(recording[IMPULSE_AT] - 1.0f) < 1e-6f
    );

    check("stop layer 0", sendAndRead(fd, "LOOP stop 0"), "ok stop=0");

    {
        const LoopStateRead stopped = readLoopState(fd);
        check("boot take length", field(stopped.layers[0], "seconds"), "0.0002");
        check("layer is playing after stop", field(stopped.layers[0], "playing"), "1");
        check("layer is no longer recording", field(stopped.layers[0], "recording"), "0");
        check("boot take set the transport", field(stopped.header, "transport"), "0.0002");
        check("untouched layer is empty", field(stopped.layers[1], "seconds"), "0.0000");
    }

    // Stop resets the playhead to the top, so the loop comes back at the same
    // offset it was recorded at.
    syncToTop(dsp, 0);
    const auto played = feed(0.0f);
    checkTrue(
        "loop returns the impulse at the recorded offset",
        std::fabs(played[IMPULSE_AT] - 1.0f) < 1e-6f
    );

    // The playhead, not the block boundary, decides where a sample lands. After
    // a 3 frame advance the impulse is the very next sample, so it has to come
    // back at index 0 even though every previous hit was at index 3.
    {
        std::array<float, 3> nudge{};
        dsp.processBlock(nudge.data(), static_cast<int>(nudge.size()));
    }

    const auto shifted = feed(0.0f);
    checkTrue(
        "playhead tracks position, not block boundaries",
        std::fabs(shifted[0] - 1.0f) < 1e-6f
    );

    // ---- the looper must survive a chain rebuild ----

    // This is the entire reason the looper lives beside the chain. Every commit
    // rebuilds each effect from scratch, so a recording held inside the chain
    // would be destroyed by anyone touching a slider.
    check("reset chain", sendAndRead(fd, "CHAIN RESET"), "ok staging=0");
    check(
        "stage unity gain",
        sendAndRead(fd, "SLOT 0 kind=gain enabled=1 gain=1.0000 mix=100.0000"),
        "ok slot=0"
    );
    check("commit over the loop", sendAndRead(fd, "CHAIN COMMIT"), "ok slots=1");

    syncToTop(dsp, 0);
    const auto afterCommit = feed(0.0f);
    checkTrue(
        "loop survives a chain commit",
        std::fabs(afterCommit[IMPULSE_AT] - 1.0f) < 1e-6f
    );

    // ---- each layer plays through the chain it captured when armed ----

    // The recorded buffer is always clean: the chain that colours a take is the
    // copy made at arm time, so the loop does not follow the live board and a
    // board change under a playing loop re-colours nothing. Pasting the board
    // onto a layer is the explicit way to re-colour it.
    check("clear for chain capture", sendAndRead(fd, "LOOP clear"), "ok cleared=all");
    check("reset chain", sendAndRead(fd, "CHAIN RESET"), "ok staging=0");
    check(
        "stage half gain",
        sendAndRead(fd, "SLOT 0 kind=gain enabled=1 gain=0.5000 mix=100.0000"),
        "ok slot=0"
    );
    check("commit half gain", sendAndRead(fd, "CHAIN COMMIT"), "ok slots=1");

    check("record under half gain", sendAndRead(fd, "LOOP record 0"), "ok record=0");
    advance(COUNTDOWN_FRAMES);
    const auto throughGain = feed(1.0f);
    check("stop layer 0", sendAndRead(fd, "LOOP stop 0"), "ok stop=0");

    {
        const LoopStateRead captured = readLoopState(fd);
        check("take captured the live chain", field(captured.layers[0], "chain"), "1");
    }

    syncToTop(dsp, 0);
    const auto withSavedChain = feed(0.0f);
    checkTrue(
        "loop plays through its captured chain",
        std::fabs(withSavedChain[IMPULSE_AT] - 0.5f) < 1e-5f
    );

    // The live board goes clean; the recorded loop must not follow it.
    check("reset chain", sendAndRead(fd, "CHAIN RESET"), "ok staging=0");
    check("commit empty", sendAndRead(fd, "CHAIN COMMIT"), "ok slots=0");

    syncToTop(dsp, 0);
    const auto afterLiveChange = feed(0.0f);
    checkTrue(
        "loop keeps its captured sound when the live board changes",
        std::fabs(afterLiveChange[IMPULSE_AT] - 0.5f) < 1e-5f
    );

    // Pasting the now-empty live board onto the layer re-colours it.
    check("paste empty chain", sendAndRead(fd, "LOOP chain 0"), "ok chain=0");

    syncToTop(dsp, 0);
    const auto afterPaste = feed(0.0f);
    checkTrue(
        "paste replaces the layer chain",
        std::fabs(afterPaste[IMPULSE_AT] - 1.0f) < 1e-6f
    );

    // ---- per layer level and mute ----

    check("zero level", sendAndRead(fd, "LOOP level 0 0.0000"), "ok level=0");
    syncToTop(dsp, 0);
    checkTrue("zero level silences the layer", std::fabs(feed(0.0f)[IMPULSE_AT]) < 1e-6f);

    check("full level", sendAndRead(fd, "LOOP level 0 100.0000"), "ok level=0");
    check("mute layer", sendAndRead(fd, "LOOP mute 0"), "ok mute=0");
    syncToTop(dsp, 0);
    checkTrue("muted layer is silent", std::fabs(feed(0.0f)[IMPULSE_AT]) < 1e-6f);
    check("unmute layer", sendAndRead(fd, "LOOP mute 0"), "ok mute=0");

    // ---- cancelling, alignment, and the forced-match rule ----

    // Stopping during a countdown cancels the arm; the layer stays empty.
    check("record layer 1 then cancel", sendAndRead(fd, "LOOP record 1"), "ok record=1");
    advance(1);
    check("stop cancels the countdown", sendAndRead(fd, "LOOP stop 1"), "ok stop=1");

    {
        const LoopStateRead canceled = readLoopState(fd);
        check("cancelled layer is empty", field(canceled.layers[1], "seconds"), "0.0000");
        check("cancelled layer not waiting", field(canceled.layers[1], "waiting"), "0");
    }

    // A later take targets the next boundary and stops there on its own. Its
    // armed max is ignored: the loop is the loop (the first recording set it).
    check("record layer 2", sendAndRead(fd, "LOOP record 2"), "ok record=2");
    advance(COUNTDOWN_FRAMES + 16);

    {
        const LoopStateRead matched = readLoopState(fd);
        check("later take matched the cycle", field(matched.layers[2], "seconds"), "0.0002");
        check("later take stopped on its own", field(matched.layers[2], "recording"), "0");
        check("later take is playing", field(matched.layers[2], "playing"), "1");
        check("later take not truncated", field(matched.layers[2], "truncated"), "0");
        check(
            "layers share the transport playhead",
            field(matched.layers[0], "pos"),
            field(matched.layers[2], "pos")
        );
        check(
            "armed max reports the cycle",
            field(matched.layers[2], "max"),
            "0.0002"
        );
    }

    // A later take stopped before its boundary is discarded, never padded:
    // a shorter loop is impossible under the forced-match rule.
    check("record layer 3", sendAndRead(fd, "LOOP record 3"), "ok record=3");
    advance(COUNTDOWN_FRAMES + 12);
    check("stop before the boundary", sendAndRead(fd, "LOOP stop 3"), "ok stop=3");

    {
        const LoopStateRead discarded = readLoopState(fd);
        check("early stop discards the take", field(discarded.layers[3], "seconds"), "0.0000");
        check("discarded take not playing", field(discarded.layers[3], "playing"), "0");
    }

    // ---- overdub ----

    // Overdubbing means hearing the old pass while laying the new one on top.
    // The length never changes underneath it.
    check("overdub layer 2", sendAndRead(fd, "LOOP record 2"), "ok record=2");
    advance(COUNTDOWN_FRAMES + 12);
    check("stop overdub", sendAndRead(fd, "LOOP stop 2"), "ok stop=2");

    {
        const LoopStateRead overdubbed = readLoopState(fd);
        check("overdub kept the length", field(overdubbed.layers[2], "seconds"), "0.0002");
        check("overdub still playing", field(overdubbed.layers[2], "playing"), "1");
    }

    // ---- the transport dies only when the last content goes ----

    check("clear all resets transport", sendAndRead(fd, "LOOP clear"), "ok cleared=all");

    {
        const LoopStateRead bare = readLoopState(fd);
        check("transport gone after clear all", field(bare.header, "transport"), "0.0000");
    }

    check("record layer 4", sendAndRead(fd, "LOOP record 4"), "ok record=4");
    advance(COUNTDOWN_FRAMES);
    feed(0.0f); // the frame that crosses the countdown, then one block of take
    check("stop layer 4", sendAndRead(fd, "LOOP stop 4"), "ok stop=4");

    {
        const LoopStateRead one = readLoopState(fd);
        check("single take transport", field(one.header, "transport"), "0.0002");
    }

    check("undo", sendAndRead(fd, "LOOP undo"), "ok cleared=last");

    {
        const LoopStateRead undone = readLoopState(fd);
        check("undo cleared the layer", field(undone.layers[4], "seconds"), "0.0000");
        check("undo killed the transport", field(undone.header, "transport"), "0.0000");
    }

    // ---- layers are independent ----

    // A second layer records while the first is empty, and the first must be
    // untouched by it.
    check("record layer 1 again", sendAndRead(fd, "LOOP record 1"), "ok record=1");
    advance(COUNTDOWN_FRAMES);
    feed(0.0f);
    check("stop layer 1", sendAndRead(fd, "LOOP stop 1"), "ok stop=1");

    const LoopStateRead twoLayers = readLoopState(fd);
    check(
        "two layer header",
        twoLayers.header,
        "ok layers=8 max=16.0000 countdown=3.0000 transport=0.0002"
    );
    check("layer 0 is still empty", field(twoLayers.layers[0], "seconds"), "0.0000");
    check("layer 1 kept its take", field(twoLayers.layers[1], "seconds"), "0.0002");

    // Playing an empty layer is a no-op rather than an error, so a button in
    // the UI cannot wedge the transport.
    check("play empty layer", sendAndRead(fd, "LOOP play 7"), "ok play=7");
    check(
        "empty layer did not start",
        field(readLoopState(fd).layers[7], "playing"),
        "0"
    );

    // ---- argument validation ----

    check("loop out of range", sendAndRead(fd, "LOOP record 99"), "error bad_value");
    check("loop negative", sendAndRead(fd, "LOOP record -1"), "error bad_value");
    check("loop bad action", sendAndRead(fd, "LOOP wibble"), "error bad_request");
    check("loop bad level", sendAndRead(fd, "LOOP level 0 abc"), "error bad_value");
    check("loop no action", sendAndRead(fd, "LOOP"), "error bad_request");
    check("loop missing index", sendAndRead(fd, "LOOP record"), "error bad_value");
    check("loop bad max", sendAndRead(fd, "LOOP record 0 max=abc"), "error bad_value");
    check("loop zero max", sendAndRead(fd, "LOOP record 0 max=0"), "error bad_value");
    check("loop chain out of range", sendAndRead(fd, "LOOP chain 99"), "error bad_value");

    // ---- the max cap truncates rather than wraps ----

    // Wrapping would silently destroy the start of the take, so recording has
    // to stop and say so. 4800 frames is a tenth of a second.
    check("clear for cap", sendAndRead(fd, "LOOP clear"), "ok cleared=all");
    check("record cap take", sendAndRead(fd, "LOOP record 0 max=0.1000"), "ok record=0");

    {
        const LoopStateRead cappedMax = readLoopState(fd);
        check("armed cap reported", field(cappedMax.layers[0], "max"), "0.1000");
    }

    // One frame past the cap: the countdown ends at startAt, the take writes
    // 4800 frames for clock in [startAt, stopAt), and the auto-stop fires on
    // the frame where clock == stopAt. Advancing to exactly stopAt would leave
    // the take recording with a full buffer, so go one frame (plus a little
    // margin) past it.
    advance(COUNTDOWN_FRAMES + 4800 + 8);

    {
        const LoopStateRead capped = readLoopState(fd);
        check("cap clamps the length", field(capped.layers[0], "seconds"), "0.1000");
        check("cap stops recording", field(capped.layers[0], "recording"), "0");
        check("cap is reported", field(capped.layers[0], "truncated"), "1");
        check("cap set the transport", field(capped.header, "transport"), "0.1000");
    }

    // ---- looper cost on the audio path ----

    // 8 layers all playing is 8 buffer reads and their captured chains per
    // sample. It has to stay far inside the period or a full board would glitch.
    check("clear for timing", sendAndRead(fd, "LOOP clear"), "ok cleared=all");
    check("empty chain for timing", sendAndRead(fd, "CHAIN RESET"), "ok staging=0");
    check("commit empty for timing", sendAndRead(fd, "CHAIN COMMIT"), "ok slots=0");

    for (int layer = 0; layer < 8; ++layer) {
        sendAndRead(fd, "LOOP record " + std::to_string(layer));

        if (layer == 0) {
            // The boot take is stopped by hand after one block of take.
            advance(COUNTDOWN_FRAMES);
            std::array<float, LOOP_FRAMES> silence{};
            dsp.processBlock(silence.data(), static_cast<int>(silence.size()));
            sendAndRead(fd, "LOOP stop 0");
        } else {
            // Layers 1..7 run a full cycle each and stop on their own; the
            // 16 frames of slack covers the rounding of the boundary target.
            advance(COUNTDOWN_FRAMES + 16);
        }
    }

    const LoopStateRead allPlaying = readLoopState(fd);

    int playingCount = 0;
    for (const auto& line : allPlaying.layers) {
        if (field(line, "playing") == "1") {
            playingCount += 1;
        }
    }
    check("all eight layers playing", std::to_string(playingCount), "8");

    const Timing loopTiming = measureBlocks(dsp, 20000);

    std::cout << "  info 8 playing layers: mean "
              << (loopTiming.total / loopTiming.blocks)
              << "us mean, of a 5333us period" << std::endl;

    checkTrue(
        "8 playing layers leave the period mostly free",
        loopTiming.total / loopTiming.blocks < 533.0
    );

    // A layer carries its captured chain on the audio path, so a board under
    // playing loops costs per layer. Pasting a two effect board onto two of the
    // empty-chain layers approximates the realistic worst case and guards the
    // thing that would bite on a live rig.
    check("reset for layer chain timing", sendAndRead(fd, "CHAIN RESET"), "ok staging=0");
    check(
        "stage overdrive for paste",
        sendAndRead(fd, "SLOT 0 kind=overdrive enabled=1 drive=4.0000 mix=80.0000"),
        "ok slot=0"
    );
    check(
        "stage bitcrush for paste",
        sendAndRead(fd, "SLOT 1 kind=bitcrush enabled=1 levels=16.0000 mix=80.0000"),
        "ok slot=1"
    );
    check("commit board for paste", sendAndRead(fd, "CHAIN COMMIT"), "ok slots=2");
    check("paste board onto layer 0", sendAndRead(fd, "LOOP chain 0"), "ok chain=0");
    check("paste board onto layer 1", sendAndRead(fd, "LOOP chain 1"), "ok chain=1");

    const Timing layerTiming = measureBlocks(dsp, 20000);

    std::cout << "  info 2 layers x 2 effects: mean "
              << (layerTiming.total / layerTiming.blocks)
              << "us mean, of a 5333us period" << std::endl;

    checkTrue(
        "two layered chains leave the period mostly free",
        layerTiming.total / layerTiming.blocks < 533.0
    );

    ::close(fd);
    server.stop();

    std::cout << (failures == 0 ? "\nall checks passed\n" : "\nFAILURES\n") << std::endl;

    return failures == 0 ? 0 : 1;
}
