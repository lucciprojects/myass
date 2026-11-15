#include "control/Base64.h"

#include <cstdint>
#include <cstring>

namespace {
constexpr char ALPHABET[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

int decodeChar(char c) {
    if (c >= 'A' && c <= 'Z') {
        return c - 'A';
    }

    if (c >= 'a' && c <= 'z') {
        return c - 'a' + 26;
    }

    if (c >= '0' && c <= '9') {
        return c - '0' + 52;
    }

    if (c == '+') {
        return 62;
    }

    if (c == '/') {
        return 63;
    }

    return -1;
}
} // namespace

std::string encodePcm(const float* samples, std::size_t count) {
    if (samples == nullptr || count == 0) {
        return "";
    }

    const auto* bytes = reinterpret_cast<const unsigned char*>(samples);
    const std::size_t length = count * sizeof(float);

    std::string result;
    result.reserve(((length + 2) / 3) * 4);

    for (std::size_t index = 0; index < length; index += 3) {
        const std::uint32_t first = bytes[index];
        const std::uint32_t second =
            index + 1 < length ? bytes[index + 1] : 0;
        const std::uint32_t third =
            index + 2 < length ? bytes[index + 2] : 0;
        const std::uint32_t triple = (first << 16) | (second << 8) | third;

        result += ALPHABET[(triple >> 18) & 0x3F];
        result += ALPHABET[(triple >> 12) & 0x3F];
        result += index + 1 < length
            ? ALPHABET[(triple >> 6) & 0x3F]
            : '=';
        result += index + 2 < length ? ALPHABET[triple & 0x3F] : '=';
    }

    return result;
}

bool decodePcm(const std::string& text, std::vector<float>& out) {
    out.clear();

    // A float is four bytes, so the encoded form of whole samples is always a
    // multiple of four characters. Anything else is a partial sample.
    if (text.size() % 4 != 0) {
        return false;
    }

    if (text.empty()) {
        return true;
    }

    std::size_t padding = 0;

    if (text[text.size() - 1] == '=') {
        padding += 1;
    }

    if (text[text.size() - 2] == '=') {
        padding += 1;
    }

    std::vector<unsigned char> bytes;
    bytes.reserve((text.size() / 4) * 3);

    for (std::size_t index = 0; index < text.size(); index += 4) {
        const bool last = index + 4 == text.size();
        int values[4] = {0, 0, 0, 0};

        for (int offset = 0; offset < 4; ++offset) {
            const char c = text[index + static_cast<std::size_t>(offset)];

            if (c == '=') {
                // Padding is only legal in the final quantum, and only in the
                // trailing `padding` characters of it.
                if (!last ||
                    static_cast<std::size_t>(offset) < 4 - padding) {
                    return false;
                }

                continue;
            }

            const int value = decodeChar(c);

            if (value < 0) {
                return false;
            }

            values[offset] = value;
        }

        const std::uint32_t triple =
            (static_cast<std::uint32_t>(values[0]) << 18) |
            (static_cast<std::uint32_t>(values[1]) << 12) |
            (static_cast<std::uint32_t>(values[2]) << 6) |
            static_cast<std::uint32_t>(values[3]);

        const int emitted = last ? 3 - static_cast<int>(padding) : 3;

        if (emitted >= 1) {
            bytes.push_back(static_cast<unsigned char>((triple >> 16) & 0xFF));
        }

        if (emitted >= 2) {
            bytes.push_back(static_cast<unsigned char>((triple >> 8) & 0xFF));
        }

        if (emitted >= 3) {
            bytes.push_back(static_cast<unsigned char>(triple & 0xFF));
        }
    }

    if (bytes.size() % sizeof(float) != 0) {
        return false;
    }

    out.resize(bytes.size() / sizeof(float));

    if (!bytes.empty()) {
        std::memcpy(out.data(), bytes.data(), bytes.size());
    }

    return true;
}
