/** Encode an SVG as an opaque image URL without creating an HTML/SVG DOM sink. */
export function svgToImageSource(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}
