// Generates the extension icons (16/48/128 px) into icons/.
// Design: rounded-square indigo (#4f46e5) background with a simple white
// shield centered. Uses Python Pillow via a here-doc so the repo needs no
// Node image dependency. Run: `node scripts/make-icons.mjs`.
//
// Pillow resolution order:
//   1. system python3 with Pillow already importable
//   2. a venv at /tmp/iconvenv (created + `pip install pillow` if needed)
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const iconsOut = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");

const PY = `
import os
from PIL import Image, ImageDraw

SIZES = [16, 48, 128]
INDIGO = (79, 70, 229, 255)      # #4f46e5
WHITE = (255, 255, 255, 255)
OUT = os.environ["ICONS_OUT"]
os.makedirs(OUT, exist_ok=True)

# Supersample for smooth edges, then downscale.
SS = 8

def shield_points(w, h):
    # A simple shield: flat top with two shoulders, tapering to a point.
    return [
        (w * 0.50, h * 0.10),   # top center
        (w * 0.86, h * 0.24),   # top right shoulder
        (w * 0.86, h * 0.55),   # right side
        (w * 0.50, h * 0.92),   # bottom point
        (w * 0.14, h * 0.55),   # left side
        (w * 0.14, h * 0.24),   # top left shoulder
    ]

for size in SIZES:
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = int(big * 0.22)
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=INDIGO)
    d.polygon(shield_points(big, big), fill=WHITE)
    img = img.resize((size, size), Image.LANCZOS)
    path = os.path.join(OUT, f"icon{size}.png")
    img.save(path, "PNG")
    print("wrote", path)
`;

function tryPython(bin) {
  try {
    execFileSync(bin, ["-c", "import PIL"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let python = null;
if (tryPython("python3")) {
  python = "python3";
} else {
  const venvPy = "/tmp/iconvenv/bin/python";
  if (!existsSync(venvPy)) {
    console.log("Pillow not found; creating venv at /tmp/iconvenv ...");
    execFileSync("python3", ["-m", "venv", "/tmp/iconvenv"], { stdio: "inherit" });
    execFileSync("/tmp/iconvenv/bin/pip", ["install", "-q", "pillow"], { stdio: "inherit" });
  }
  python = venvPy;
}

const out = execFileSync(python, ["-c", PY], {
  encoding: "utf8",
  env: { ...process.env, ICONS_OUT: iconsOut },
});
process.stdout.write(out);
