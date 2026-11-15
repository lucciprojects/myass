#pragma once

#include <cstddef>
#include <string>
#include <vector>

// PCM crosses the control socket as base64: the protocol is line based, so a
// raw float buffer would be the one place a zero byte could look like the end
// of a line to some reader. Encoding is also what bounds a transfer command to
// a predictable size.
std::string encodePcm(const float* samples, std::size_t count);

// Rejects malformed text, wrong padding and any byte count that is not a whole
// number of floats, so a truncated chunk cannot silently become audio.
bool decodePcm(const std::string& text, std::vector<float>& out);
