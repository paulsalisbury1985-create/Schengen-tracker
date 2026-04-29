#!/usr/bin/env python3
# Generate simple placeholder icons
import struct, zlib, base64

def make_png(size, bg=(7,7,15), fg=(124,111,247)):
    """Create a simple PNG with 'S' letter for Schengen"""
    w = h = size
    # Simple solid color with border
    rows = []
    border = max(2, size//32)
    inner = size // 3
    for y in range(h):
        row = []
        for x in range(w):
            # Border
            if x < border or x >= w-border or y < border or y >= h-border:
                row.extend([80, 70, 180])
            # Simple 'S' shape approximation - just accent colored center block
            elif (w//4 <= x <= 3*w//4) and (h//4 <= y <= 3*h//4):
                row.extend(list(fg))
            else:
                row.extend(list(bg))
        rows.append(bytes([0] + row))
    
    raw = b''.join(rows)
    compressed = zlib.compress(raw)
    
    def chunk(name, data):
        c = name + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', compressed)
    png += chunk(b'IEND', b'')
    return png

for size, name in [(192, 'icon-192.png'), (512, 'icon-512.png')]:
    with open(f'/home/claude/schengen-pwa/{name}', 'wb') as f:
        f.write(make_png(size))
    print(f'Created {name}')
