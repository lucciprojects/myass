// Exercises the control socket end to end without touching ALSA, so the chain
// transaction can be verified on a machine with no sound card.

#include "control/ControlServer.h"
#include "control/Base64.h"
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

    // The audio assertions in this suite compare exact samples, so the
    // metronome — which is correct behaviour during a take — is turned off
    // here and exercised on its own further down.
    check("click off for exact samples", sendAndRead(fd, "LOOP click off"), "ok click=off");

    // Eight frames per block, with a single impulse at index 3. A loop of
    // exactly 8 frames then returns that impulse at a predictable place, which
    // a sine could not.
    constexpr int LOOP_FRAMES = 8;
    constexpr int IMPULSE_AT = 3;

    // One bar at 120 BPM: 48000 * 60/120 * 4. The count-in is derived from the
    // tempo, so the test's job is to cross one bar, not to know a constant by
    // heart.
    constexpr std::size_t COUNTDOWN_FRAMES = 48000 * 2;

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
        check("countdown at full", field(armed.layers[0], "countdown"), "2.0000");
        check("armed layer default max", field(armed.layers[0], "max"), "32.0000");
        check("armed layer captured the live chain", field(armed.layers[0], "chain"), "1");
    }

    // 1000 frames in, the countdown has moved but the take has not started.
    advance(1000);

    {
        const LoopStateRead tick = readLoopState(fd);
        check("countdown has moved", field(tick.layers[0], "countdown"), "1.9792");
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
    // Field by field rather than the whole line: the header now carries a
    // revision counter that moves on every change, and a literal match would
    // fail for a reason that has nothing to do with what this test checks.
    check("two layer header layers", field(twoLayers.header, "layers"), "8");
    check("two layer header cap", field(twoLayers.header, "max"), "32.0000");
    check("two layer header rate", field(twoLayers.header, "rate"), "48000");
    check("two layer header tempo", field(twoLayers.header, "bpm"), "120.0000");
    check("two layer header meter", field(twoLayers.header, "beats"), "4");
    check("two layer header free mode", field(twoLayers.header, "bars"), "0");
    check(
        "two layer header click",
        field(twoLayers.header, "click"),
        "off"
    );
    check("two layer header countdown", field(twoLayers.header, "countdown"), "2.0000");
    check("two layer header transport", field(twoLayers.header, "transport"), "0.0002");
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

    // ---- tempo, bars and the click ----

    // A tempo cannot move under existing audio: there is no time stretch, so
    // the player clears first. This is a refusal, not a silent re-grid.
    check("tempo refused with content", sendAndRead(fd, "LOOP tempo 90"), "error busy");

    check("clear for tempo", sendAndRead(fd, "LOOP clear"), "ok cleared=all");
    check(
        "tempo accepted when empty",
        sendAndRead(fd, "LOOP tempo 90"),
        "ok bpm=90.0000 beats=4"
    );

    {
        const LoopStateRead slowed = readLoopState(fd);
        check("tempo reported", field(slowed.header, "bpm"), "90.0000");
        // One bar at 90 BPM is four beats of 32000 samples: 2.6667s.
        check("one bar at 90", field(slowed.header, "countdown"), "2.6667");
    }

    check("tempo out of range", sendAndRead(fd, "LOOP tempo 300"), "error bad_value");
    check("tempo bad meter", sendAndRead(fd, "LOOP tempo 90 beats=3"), "error bad_value");

    check("bars accepted", sendAndRead(fd, "LOOP bars 4"), "ok bars=4");

    {
        const LoopStateRead fourBars = readLoopState(fd);
        check("bars reported", field(fourBars.header, "bars"), "4");
    }

    check("bars out of range", sendAndRead(fd, "LOOP bars 999"), "error bad_value");
    // 13 bars at 90 BPM is 34.7s, past the 32s buffer.
    check("bars beyond the cap", sendAndRead(fd, "LOOP bars 13"), "error bad_value");

    // An armed take locks the grid too, otherwise its stop point would move
    // underneath it.
    check("record for lockout", sendAndRead(fd, "LOOP record 0"), "ok record=0");
    advance(1);
    check("tempo refused while armed", sendAndRead(fd, "LOOP tempo 100"), "error busy");
    check("bars refused while armed", sendAndRead(fd, "LOOP bars 2"), "error busy");
    check("cancel the locked take", sendAndRead(fd, "LOOP stop 0"), "ok stop=0");

    const LoopStateRead beforeQuantized = readLoopState(fd);

    // One bar of count-in (128000 samples at 90 BPM), then exactly four bars
    // (512000 samples) and an automatic stop. The take defines the cycle.
    check("record quantized take", sendAndRead(fd, "LOOP record 0"), "ok record=0");
    advance(128000 + 512000 + 8);

    {
        const LoopStateRead quantized = readLoopState(fd);
        check("quantized take length", field(quantized.layers[0], "samples"), "512000");
        check("quantized take seconds", field(quantized.layers[0], "seconds"), "10.6667");
        check("quantized take stopped itself", field(quantized.layers[0], "recording"), "0");
        check("quantized take is playing", field(quantized.layers[0], "playing"), "1");
        check(
            "quantized take is not truncated",
            field(quantized.layers[0], "truncated"),
            "0"
        );
        check("quantized take set the cycle", field(quantized.header, "loop"), "512000");
        check(
            "quantized take set the transport",
            field(quantized.header, "transport"),
            "10.6667"
        );
        checkTrue(
            "take bumped the layer revision",
            std::stoull(field(quantized.layers[0], "rev")) >
                std::stoull(field(beforeQuantized.layers[0], "rev"))
        );
    }

    // Level changes are visible state but not audio: the layer revision stays
    // put, so an auto-save would not dump the samples again.
    {
        const LoopStateRead beforeLevel = readLoopState(fd);
        sendAndRead(fd, "LOOP level 0 50.0000");
        const LoopStateRead afterLevel = readLoopState(fd);

        check(
            "level leaves the layer revision alone",
            field(afterLevel.layers[0], "rev"),
            field(beforeLevel.layers[0], "rev")
        );
        checkTrue(
            "level bumps the global revision",
            std::stoull(field(afterLevel.header, "rev")) >
                std::stoull(field(beforeLevel.header, "rev"))
        );
    }

    // Stopping a quantized take early discards it: the bars were chosen before
    // arming, so a partial bar is not a loop.
    check("clear for early stop", sendAndRead(fd, "LOOP clear"), "ok cleared=all");
    check("record early stop", sendAndRead(fd, "LOOP record 0"), "ok record=0");
    advance(128000 + 100);
    check("stop early", sendAndRead(fd, "LOOP stop 0"), "ok stop=0");

    {
        const LoopStateRead discarded = readLoopState(fd);
        check(
            "early stop discarded the take",
            field(discarded.layers[0], "samples"),
            "0"
        );
        check(
            "early stop left no transport",
            field(discarded.header, "transport"),
            "0.0000"
        );
    }

    // FREE restores stop-defines-length, which is what the rest of this suite
    // (and the pre-tempo UI) expects.
    check("free mode", sendAndRead(fd, "LOOP bars 0"), "ok bars=0");
    check("record free take", sendAndRead(fd, "LOOP record 0"), "ok record=0");
    advance(128000);
    feed(0.0f);
    check("stop free take", sendAndRead(fd, "LOOP stop 0"), "ok stop=0");

    {
        const LoopStateRead free = readLoopState(fd);
        check("free take kept its own length", field(free.layers[0], "samples"), "8");
    }

    // ---- the click ----

    check("clear for click", sendAndRead(fd, "LOOP clear"), "ok cleared=all");
    check("click off", sendAndRead(fd, "LOOP click off"), "ok click=off");
    check("record with click off", sendAndRead(fd, "LOOP record 0"), "ok record=0");

    {
        std::array<float, 256> block{};
        dsp.processBlock(block.data(), static_cast<int>(block.size()));

        float peak = 0.0f;

        for (const float sample : block) {
            peak = std::max(peak, std::fabs(sample));
        }

        checkTrue("click off is silent during the count-in", peak == 0.0f);
    }

    check("cancel silent take", sendAndRead(fd, "LOOP stop 0"), "ok stop=0");

    check(
        "click on",
        sendAndRead(fd, "LOOP click countin-record"),
        "ok click=countin-record"
    );
    check("record with click on", sendAndRead(fd, "LOOP record 0"), "ok record=0");

    {
        std::array<float, 256> block{};
        dsp.processBlock(block.data(), static_cast<int>(block.size()));

        float peak = 0.0f;

        for (const float sample : block) {
            peak = std::max(peak, std::fabs(sample));
        }

        checkTrue("count-in clicks on the downbeat", peak > 0.1f);
    }

    check("cancel clicking take", sendAndRead(fd, "LOOP stop 0"), "ok stop=0");
    check("clear after click", sendAndRead(fd, "LOOP clear"), "ok cleared=all");
    check("click back off", sendAndRead(fd, "LOOP click off"), "ok click=off");

    // Back to the tempo the rest of the suite assumes. 120 BPM makes a bar
    // 96000 samples, which is what COUNTDOWN_FRAMES encodes.
    check(
        "restore tempo",
        sendAndRead(fd, "LOOP tempo 120"),
        "ok bpm=120.0000 beats=4"
    );

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

    // ---- project transfer ----

    std::cout << "transfer" << std::endl;

    check("clear chain for transfer", sendAndRead(fd, "CHAIN RESET"), "ok staging=0");
    check("commit clear for transfer", sendAndRead(fd, "CHAIN COMMIT"), "ok slots=0");
    check("clear all for transfer", sendAndRead(fd, "LOOP clear"), "ok cleared=all");
    check("tempo for transfer", sendAndRead(fd, "LOOP tempo 120"), "ok bpm=120.0000 beats=4");
    check("bars for transfer", sendAndRead(fd, "LOOP bars 0"), "ok bars=0");
    check("click off for transfer", sendAndRead(fd, "LOOP click off"), "ok click=off");

    // A known ramp makes a dump checkable bit for bit rather than merely by
    // length. The first sample lands at index 0 because the take starts on the
    // block after the count-in is crossed.
    const std::array<float, 8> RAMP{
        {0.125f, 0.25f, 0.375f, 0.5f, 0.625f, 0.75f, 0.875f, 1.0f}
    };

    check("record for dump", sendAndRead(fd, "LOOP record 0"), "ok record=0");
    advance(COUNTDOWN_FRAMES);

    {
        std::array<float, 8> take = RAMP;
        dsp.processBlock(take.data(), static_cast<int>(take.size()));
    }

    check("stop for dump", sendAndRead(fd, "LOOP stop 0"), "ok stop=0");

    {
        const std::string reply = sendAndRead(fd, "LOOP dump 0 0 8");
        check("dump offset", field(reply, "offset"), "0");
        check("dump count", field(reply, "count"), "8");
        check("dump total", field(reply, "total"), "8");

        std::vector<float> dumped;
        checkTrue("dump base64 decoded", decodePcm(field(reply, "data"), dumped));
        checkTrue("dump length", dumped.size() == RAMP.size());

        bool exact = dumped.size() == RAMP.size();

        for (std::size_t index = 0; exact && index < RAMP.size(); ++index) {
            exact = dumped[index] == RAMP[index];
        }

        checkTrue("dump is bit exact", exact);
    }

    {
        const std::string reply = sendAndRead(fd, "LOOP dump 0 3 3");
        check("partial dump offset", field(reply, "offset"), "3");
        check("partial dump count", field(reply, "count"), "3");

        std::vector<float> dumped;
        checkTrue("partial dump decoded", decodePcm(field(reply, "data"), dumped));
        checkTrue(
            "partial dump starts at index 3",
            dumped.size() == 3 && dumped[0] == RAMP[3] &&
                dumped[2] == RAMP[5]
        );
    }

    {
        const std::string reply = sendAndRead(fd, "LOOP dump 0 8 4");
        check("past end count", field(reply, "count"), "0");
        check("past end total", field(reply, "total"), "8");
        check("past end empty data", field(reply, "data"), "");
    }

    check("dump over the chunk cap", sendAndRead(fd, "LOOP dump 0 0 9000"), "error bad_value");
    check("dump with a negative offset", sendAndRead(fd, "LOOP dump 0 -1 1"), "error bad_value");
    check("dump with a bad layer", sendAndRead(fd, "LOOP dump 99 0 1"), "error bad_value");

    check("arm layer 1 for busy dump", sendAndRead(fd, "LOOP record 1"), "ok record=1");
    check("dump while armed is busy", sendAndRead(fd, "LOOP dump 1 0 8"), "error busy");
    check("cancel the busy dump take", sendAndRead(fd, "LOOP stop 1"), "ok stop=1");

    // ---- aborting a staged load ----

    const LoopStateRead beforeAbort = readLoopState(fd);

    check("abort begin", sendAndRead(fd, "PROJECT LOAD BEGIN"), "ok staged=1");
    check(
        "abort layer begin",
        sendAndRead(fd, "PROJECT LOAD LAYER 0 BEGIN 8"),
        "ok layer=0 samples=8"
    );
    check(
        "abort layer data",
        sendAndRead(
            fd,
            "PROJECT LOAD LAYER 0 DATA 0 " + encodePcm(RAMP.data(), RAMP.size())
        ),
        "ok offset=0 count=8"
    );
    check("abort session", sendAndRead(fd, "PROJECT LOAD ABORT"), "ok aborted=1");

    {
        const LoopStateRead afterAbort = readLoopState(fd);
        check(
            "abort leaves the revision",
            field(afterAbort.header, "rev"),
            field(beforeAbort.header, "rev")
        );
        check(
            "abort leaves the length",
            field(afterAbort.layers[0], "samples"),
            field(beforeAbort.layers[0], "samples")
        );
    }

    check(
        "commit after abort is refused",
        sendAndRead(
            fd,
            "PROJECT LOAD COMMIT bpm=120.0000 beats=4 bars=0 click=off loop=8"
        ),
        "error bad_request"
    );

    // A chunk that runs past the length the layer was begun with aborts the
    // session rather than leaving a short layer for COMMIT to reject.
    check("bad chunk begin", sendAndRead(fd, "PROJECT LOAD BEGIN"), "ok staged=1");
    check(
        "bad chunk layer",
        sendAndRead(fd, "PROJECT LOAD LAYER 0 BEGIN 4"),
        "ok layer=0 samples=4"
    );
    check(
        "overlong chunk aborts",
        sendAndRead(
            fd,
            "PROJECT LOAD LAYER 0 DATA 2 " + encodePcm(RAMP.data(), 3)
        ),
        "error bad_value"
    );
    check(
        "commit after a bad chunk is refused",
        sendAndRead(
            fd,
            "PROJECT LOAD COMMIT bpm=120.0000 beats=4 bars=0 click=off loop=4"
        ),
        "error bad_request"
    );

    check("bad base64 begin", sendAndRead(fd, "PROJECT LOAD BEGIN"), "ok staged=1");
    check(
        "bad base64 layer",
        sendAndRead(fd, "PROJECT LOAD LAYER 0 BEGIN 4"),
        "ok layer=0 samples=4"
    );
    check(
        "bad base64 aborts",
        sendAndRead(fd, "PROJECT LOAD LAYER 0 DATA 0 !!!!"),
        "error bad_value"
    );

    {
        const LoopStateRead afterBad = readLoopState(fd);
        check(
            "a failed load leaves the length",
            field(afterBad.layers[0], "samples"),
            field(beforeAbort.layers[0], "samples")
        );
        check(
            "a failed load leaves the revision",
            field(afterBad.header, "rev"),
            field(beforeAbort.header, "rev")
        );
    }

    // ---- a two layer project load ----

    const std::array<float, 4> LOAD_A{{0.1f, 0.2f, 0.3f, 0.4f}};
    const std::array<float, 4> LOAD_B{{-0.5f, -0.25f, 0.25f, 0.5f}};

    check("load begin", sendAndRead(fd, "PROJECT LOAD BEGIN"), "ok staged=1");

    check(
        "load layer 0 begin",
        sendAndRead(fd, "PROJECT LOAD LAYER 0 BEGIN 4"),
        "ok layer=0 samples=4"
    );
    check(
        "load layer 0 data",
        sendAndRead(
            fd,
            "PROJECT LOAD LAYER 0 DATA 0 " +
                encodePcm(LOAD_A.data(), LOAD_A.size())
        ),
        "ok offset=0 count=4"
    );
    check(
        "load layer 0 meta",
        sendAndRead(
            fd,
            "PROJECT LOAD LAYER 0 META level=80.0000 muted=0 playing=1 truncated=0"
        ),
        "ok layer=0"
    );

    check("load chain 0 reset", sendAndRead(fd, "PROJECT CHAIN RESET"), "ok staging=0");
    check(
        "load chain 0 slot",
        sendAndRead(
            fd,
            "PROJECT CHAIN SLOT 0 kind=gain enabled=1 gain=2.0000 mix=100.0000"
        ),
        "ok slot=0"
    );
    check("load chain 0 commit", sendAndRead(fd, "PROJECT CHAIN COMMIT 0"), "ok chain=0");

    check(
        "load layer 1 begin",
        sendAndRead(fd, "PROJECT LOAD LAYER 1 BEGIN 4"),
        "ok layer=1 samples=4"
    );
    check(
        "load layer 1 data",
        sendAndRead(
            fd,
            "PROJECT LOAD LAYER 1 DATA 0 " +
                encodePcm(LOAD_B.data(), LOAD_B.size())
        ),
        "ok offset=0 count=4"
    );
    check(
        "load layer 1 meta",
        sendAndRead(
            fd,
            "PROJECT LOAD LAYER 1 META level=50.0000 muted=1 playing=0 truncated=1"
        ),
        "ok layer=1"
    );

    // The board travels with the project but is applied at the same commit as
    // the audio, never while the load is still being staged.
    check("load board reset", sendAndRead(fd, "PROJECT BOARD RESET"), "ok staging=0");
    check(
        "load board slot",
        sendAndRead(
            fd,
            "PROJECT BOARD SLOT 0 kind=gain enabled=1 gain=2.0000 mix=100.0000"
        ),
        "ok slot=0"
    );
    check("load board commit", sendAndRead(fd, "PROJECT BOARD COMMIT"), "ok slots=1");

    check(
        "load commit",
        sendAndRead(
            fd,
            "PROJECT LOAD COMMIT bpm=100.0000 beats=4 bars=0 click=off loop=4"
        ),
        "ok loaded=2"
    );

    {
        const LoopStateRead loaded = readLoopState(fd);

        check("loaded bpm", field(loaded.header, "bpm"), "100.0000");
        check("loaded beats", field(loaded.header, "beats"), "4");
        check("loaded bars", field(loaded.header, "bars"), "0");
        check("loaded click", field(loaded.header, "click"), "off");
        check("loaded loop", field(loaded.header, "loop"), "4");
        check("load lands paused", field(loaded.header, "paused"), "1");

        check("loaded layer 0 samples", field(loaded.layers[0], "samples"), "4");
        check("loaded layer 0 level", field(loaded.layers[0], "level"), "80.0000");
        check("loaded layer 0 playing", field(loaded.layers[0], "playing"), "1");
        check("loaded layer 0 muted", field(loaded.layers[0], "muted"), "0");
        check("loaded layer 0 chain matches the board", field(loaded.layers[0], "chain"), "1");

        check("loaded layer 1 samples", field(loaded.layers[1], "samples"), "4");
        check("loaded layer 1 level", field(loaded.layers[1], "level"), "50.0000");
        check("loaded layer 1 playing", field(loaded.layers[1], "playing"), "0");
        check("loaded layer 1 muted", field(loaded.layers[1], "muted"), "1");
        check("loaded layer 1 truncated", field(loaded.layers[1], "truncated"), "1");
        check("loaded layer 1 chain differs", field(loaded.layers[1], "chain"), "0");
    }

    {
        const std::string header = sendAndRead(fd, "CHAIN GET layer=0");
        check("layer 0 chain header", header, "ok slots=1");
        check(
            "layer 0 chain slot",
            readLine(fd),
            "slot 0 kind=gain enabled=1 gain=2.0000 mix=100.0000"
        );
        check("layer 0 chain terminator", readLine(fd), "end");
    }

    {
        const std::string header = sendAndRead(fd, "CHAIN GET layer=2");
        check("empty layer chain header", header, "ok slots=0");
        check("empty layer chain terminator", readLine(fd), "end");
    }

    // Restoring is deliberate, so the rig stays silent until the player
    // resumes; then layer 0 plays its saved audio through its saved gain and
    // layer 1 stays out because it was saved stopped and muted.
    {
        std::array<float, 2> silent{{0.0f, 0.0f}};
        dsp.processBlock(silent.data(), 2);
        checkTrue(
            "loaded rig is silent while paused",
            silent[0] == 0.0f && silent[1] == 0.0f
        );
    }

    check("resume after load", sendAndRead(fd, "LOOP play"), "ok play=all");

    {
        std::array<float, 2> block{{0.0f, 0.0f}};
        dsp.processBlock(block.data(), 2);

        // Chain first, then the layer level, exactly as the audio path does.
        const float first = LOAD_A[0] * 2.0f * 0.8f;
        const float second = LOAD_A[1] * 2.0f * 0.8f;

        checkTrue(
            "loaded layer 0 plays sample 0",
            std::fabs(block[0] - first) < 1e-6f
        );
        checkTrue(
            "loaded layer 0 plays sample 1",
            std::fabs(block[1] - second) < 1e-6f
        );
    }

    // ---- a layer chain never touches the live board ----

    const auto liveBoard = dsp.snapshot();

    check("layer chain reset", sendAndRead(fd, "CHAIN RESET"), "ok staging=0");
    check(
        "layer chain stage",
        sendAndRead(
            fd,
            "SLOT 0 kind=overdrive enabled=1 drive=4.0000 mix=80.0000"
        ),
        "ok slot=0"
    );
    check("layer chain commit", sendAndRead(fd, "CHAIN COMMIT layer=2"), "ok chain=2");

    {
        const auto after = dsp.snapshot();

        checkTrue("layer chain leaves the board size", after.size() == liveBoard.size());

        bool same = after.size() == liveBoard.size();

        for (std::size_t index = 0; same && index < after.size(); ++index) {
            same = after[index].kind == liveBoard[index].kind &&
                after[index].enabled == liveBoard[index].enabled &&
                after[index].params == liveBoard[index].params;
        }

        checkTrue("layer chain leaves the board identity", same);
    }

    {
        const std::string header = sendAndRead(fd, "CHAIN GET layer=2");
        check("layer 2 chain header", header, "ok slots=1");
        check(
            "layer 2 chain slot",
            readLine(fd),
            "slot 0 kind=overdrive enabled=1 drive=4.0000 mix=80.0000"
        );
        check("layer 2 chain terminator", readLine(fd), "end");
    }

    {
        const std::string header = sendAndRead(fd, "CHAIN GET");
        check("live chain still readable", header, "ok slots=1");
        check(
            "live chain is still the loaded board",
            readLine(fd),
            "slot 0 kind=gain enabled=1 gain=2.0000 mix=100.0000"
        );
        check("live chain terminator", readLine(fd), "end");
    }

    // ---- the private render chain ----

    check("arm layer 3 for render busy", sendAndRead(fd, "LOOP record 3"), "ok record=3");
    check("render refuses an active take", sendAndRead(fd, "RENDER BEGIN"), "error busy");
    check("cancel the render busy take", sendAndRead(fd, "LOOP stop 3"), "ok stop=3");

    const std::array<float, 4> RENDER_IN{{0.1f, 0.2f, 0.3f, 0.4f}};

    check("render begin", sendAndRead(fd, "RENDER BEGIN"), "ok render=1");
    check("render reset", sendAndRead(fd, "RENDER RESET"), "ok staging=0");
    check(
        "render gain slot",
        sendAndRead(
            fd,
            "RENDER SLOT 0 kind=gain enabled=1 gain=2.0000 mix=100.0000"
        ),
        "ok slot=0"
    );
    check("render commit", sendAndRead(fd, "RENDER COMMIT"), "ok slots=1");

    std::vector<float> rendered;

    {
        const std::string reply = sendAndRead(
            fd,
            "RENDER DATA " + encodePcm(RENDER_IN.data(), 2)
        );
        check("render first chunk count", field(reply, "count"), "2");

        std::vector<float> chunk;
        checkTrue("render first chunk decoded", decodePcm(field(reply, "data"), chunk));
        rendered.insert(rendered.end(), chunk.begin(), chunk.end());
    }

    {
        const std::string reply = sendAndRead(
            fd,
            "RENDER DATA " + encodePcm(RENDER_IN.data() + 2, 2)
        );
        check("render second chunk count", field(reply, "count"), "2");

        std::vector<float> chunk;
        checkTrue("render second chunk decoded", decodePcm(field(reply, "data"), chunk));
        rendered.insert(rendered.end(), chunk.begin(), chunk.end());
    }

    checkTrue(
        "render gain split across chunks is exact",
        rendered.size() == 4 &&
            std::fabs(rendered[0] - 0.2f) < 1e-6f &&
            std::fabs(rendered[1] - 0.4f) < 1e-6f &&
            std::fabs(rendered[2] - 0.6f) < 1e-6f &&
            std::fabs(rendered[3] - 0.8f) < 1e-6f
    );

    check("render end", sendAndRead(fd, "RENDER END"), "ok render=0");

    // A stateful effect must see one continuous signal across chunks. A
    // downsample of four holds every fourth input; splitting the same six
    // samples into two calls has to produce the same held value as one call.
    const std::array<float, 6> STATE_IN{{0.1f, 0.2f, 0.3f, 0.4f, 0.5f, 0.6f}};

    const auto renderStateful = [&](bool split) {
        const std::string suffix = split ? " split" : " whole";

        check(
            "stateful begin" + suffix,
            sendAndRead(fd, "RENDER BEGIN"),
            "ok render=1"
        );
        check(
            "stateful reset" + suffix,
            sendAndRead(fd, "RENDER RESET"),
            "ok staging=0"
        );
        check(
            "stateful slot" + suffix,
            sendAndRead(
                fd,
                "RENDER SLOT 0 kind=downsample enabled=1 divisor=4.0000 mix=100.0000"
            ),
            "ok slot=0"
        );
        check(
            "stateful commit" + suffix,
            sendAndRead(fd, "RENDER COMMIT"),
            "ok slots=1"
        );

        std::vector<float> result;

        if (split) {
            for (std::size_t offset = 0; offset < STATE_IN.size(); offset += 3) {
                const std::size_t count =
                    std::min<std::size_t>(3, STATE_IN.size() - offset);
                const std::string reply = sendAndRead(
                    fd,
                    "RENDER DATA " +
                        encodePcm(STATE_IN.data() + offset, count)
                );

                std::vector<float> chunk;
                checkTrue(
                    "stateful chunk decoded" + suffix,
                    decodePcm(field(reply, "data"), chunk)
                );
                result.insert(result.end(), chunk.begin(), chunk.end());
            }
        } else {
            const std::string reply = sendAndRead(
                fd,
                "RENDER DATA " +
                    encodePcm(STATE_IN.data(), STATE_IN.size())
            );

            checkTrue(
                "stateful chunk decoded" + suffix,
                decodePcm(field(reply, "data"), result)
            );
        }

        check(
            "stateful end" + suffix,
            sendAndRead(fd, "RENDER END"),
            "ok render=0"
        );

        return result;
    };

    const std::vector<float> stateWhole = renderStateful(false);
    const std::vector<float> stateSplit = renderStateful(true);

    checkTrue("stateful whole length", stateWhole.size() == STATE_IN.size());
    checkTrue("stateful split length", stateSplit.size() == STATE_IN.size());
    checkTrue(
        "stateful render is chunk independent",
        stateWhole.size() == stateSplit.size() &&
            std::equal(stateWhole.begin(), stateWhole.end(), stateSplit.begin())
    );
    checkTrue(
        "stateful render carried the held value across the split",
        stateSplit.size() == STATE_IN.size() &&
            std::fabs(stateSplit[3] - STATE_IN[3]) < 1e-6f
    );

    // ---- a half staged load and the line cap survive a reconnect ----

    check("stage before disconnect", sendAndRead(fd, "PROJECT LOAD BEGIN"), "ok staged=1");
    check(
        "layer before disconnect",
        sendAndRead(fd, "PROJECT LOAD LAYER 0 BEGIN 4"),
        "ok layer=0 samples=4"
    );

    ::close(fd);

    const int reconnectFd = connectToAgent();
    checkTrue("reconnected after transfer", reconnectFd >= 0);

    if (reconnectFd >= 0) {
        check(
            "a staged load does not survive the disconnect",
            sendAndRead(
                reconnectFd,
                "PROJECT LOAD COMMIT bpm=120.0000 beats=4 bars=0 click=off loop=4"
            ),
            "error bad_request"
        );

        // One byte past the cap is enough: the whole line fits in the socket
        // buffer, so the server can read it all before replying and closing.
        const std::string huge(131072 + 1, 'A');
        std::size_t sent = 0;

        while (sent < huge.size()) {
            const ssize_t written = ::send(
                reconnectFd,
                huge.data() + sent,
                huge.size() - sent,
                MSG_NOSIGNAL
            );

            if (written <= 0) {
                break;
            }

            sent += static_cast<std::size_t>(written);
        }

        check("oversized line is rejected", readLine(reconnectFd), "error line_too_long");
        ::close(reconnectFd);
    }

    {
        const int finalFd = connectToAgent();

        if (finalFd < 0) {
            checkTrue("reconnected after an oversized line", false);
        } else {
            check("ping after the session reset", sendAndRead(finalFd, "PING"), "ok pong");
            ::close(finalFd);
        }
    }

    server.stop();

    std::cout << (failures == 0 ? "\nall checks passed\n" : "\nFAILURES\n") << std::endl;

    return failures == 0 ? 0 : 1;
}
