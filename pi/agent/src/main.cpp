#include <iostream>

#include "effects/Distortion.h"

int main()
{
std::cout << "MYASS agent starting..." << std::endl;

Distortion distortion;

distortion.setDrive(5.0f);

std::cout << "Distortion initialized." << std::endl;
std::cout << "Drive: "
          << distortion.getDrive()
          << std::endl;

return 0;

}
