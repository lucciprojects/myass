# MYASS DSP

The eventual Pi implementation is C++.

Initial audio target:

- 48 kHz
- 24-bit
- low buffer size
- predictable latency

The first effect is distortion.

The simulator does not process live audio; it simulates the device control plane so the web/API can be developed before hardware arrives.

Real-time DSP must never depend on:

- HTTP requests
- database queries
- WebSocket callbacks
- dynamic UI state
