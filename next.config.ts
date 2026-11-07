import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: "4mb" }, // นำเข้า CSV ขนาดใหญ่ได้
  },
};

export default nextConfig;
