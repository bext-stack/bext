/**
 * next/image compatibility shim for PRISM.
 *
 * Renders an optimized <img> tag. When bext-server is running, images
 * are served through bext's native image optimization pipeline
 * (resize, WebP/AVIF conversion, blur placeholder).
 *
 * In dev mode (PRISM serve.ts), images are served as-is.
 *
 * Supports the same props as next/image:
 *   <Image src="/photo.jpg" width={800} height={600} alt="Photo" />
 *   <Image src="/hero.png" fill alt="Hero" />
 */

import React from "react";

interface ImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  fill?: boolean;
  quality?: number;
  priority?: boolean;
  placeholder?: "blur" | "empty";
  blurDataURL?: string;
  sizes?: string;
  unoptimized?: boolean;
}

function Image({
  src, alt, width, height, fill, quality, priority, placeholder,
  blurDataURL, sizes, unoptimized, style, ...rest
}: ImageProps) {
  // Build optimized URL via bext's image pipeline
  let optimizedSrc = src;
  if (!unoptimized && !src.startsWith("http") && !src.startsWith("data:")) {
    const params = new URLSearchParams();
    if (width) params.set("w", String(width));
    if (quality) params.set("q", String(quality));
    const qs = params.toString();
    if (qs) optimizedSrc = `/_bext/image?url=${encodeURIComponent(src)}&${qs}`;
  }

  const imgStyle: React.CSSProperties = fill
    ? { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", ...style as any }
    : { ...style as any };

  return React.createElement("img", {
    src: optimizedSrc,
    alt,
    width: fill ? undefined : width,
    height: fill ? undefined : height,
    loading: priority ? "eager" : "lazy",
    decoding: "async",
    sizes,
    style: imgStyle,
    ...rest,
  });
}

export default Image;
export { Image };
