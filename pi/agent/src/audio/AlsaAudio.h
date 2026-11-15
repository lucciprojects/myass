#pragma once

#include <alsa/asoundlib.h>

class AlsaAudio {
public:
    AlsaAudio();
    ~AlsaAudio();

    bool open();
    void close();

    bool read(float* buffer, int frames);
    bool write(const float* buffer, int frames);

    // How many transfers have been dropped because a stream stopped handing
    // over periods. Surfaced so the periodic log can say so, because a wedged
    // device is otherwise indistinguishable from a rig that is merely idle.
    int stalls() const { return stalls_; }

private:
    snd_pcm_t* input_ = nullptr;
    snd_pcm_t* output_ = nullptr;
    int stalls_ = 0;

    // False opens the streams blocking, so transfers wait inside alsa-lib
    // instead of being retried here. See boundedWait().
    bool boundedWaitEnabled = true;
};