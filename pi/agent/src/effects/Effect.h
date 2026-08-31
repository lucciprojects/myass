#pragma once

class Effect {
public:
virtual ~Effect() = default;

```
virtual void process(
    float* buffer,
    int numSamples
) = 0;

virtual void reset() = 0;
```

};
