import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@myass/types", "@myass/effects"],
};

export default nextConfig;
