"use client";

import Image from "next/image";

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <Image
      src="/logo-128.png"
      alt="YLD.fi"
      width={size}
      height={size}
      className="rounded-full"
    />
  );
}
