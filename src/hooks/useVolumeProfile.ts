"use client";

import { useQuery } from "@tanstack/react-query";
import { CACHE_TIMES } from "@/config/query";

const R2_BASE = "https://data.yldfi.co";

export interface VolumeProfileBin {
  price: number;
  volume: number;
  tpo: number;
}

export interface VolumeProfileTimeframe {
  startTime: number;
  endTime: number;
  poc: number;
  vah: number;
  val: number;
  bins: VolumeProfileBin[];
}

export interface VolumeProfileData {
  version: number;
  generatedAt: string;
  timeframes: {
    "30d": VolumeProfileTimeframe;
    "90d": VolumeProfileTimeframe;
    all: VolumeProfileTimeframe;
  };
}

export type VolumeProfilePeriod = "30d" | "90d" | "all";

export function useVolumeProfile() {
  return useQuery<VolumeProfileData | null>({
    queryKey: ["volumeProfile"],
    queryFn: async () => {
      const res = await fetch(
        `${R2_BASE}/prices/ycvxcrv/volume-profile.json`,
      );
      if (!res.ok) return null;
      return res.json();
    },
    ...CACHE_TIMES.STATIC,
  });
}
