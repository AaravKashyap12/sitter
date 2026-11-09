# Reference

Put the image you want painted in this folder, then describe it in `reference.json`:

```sh
cp reference/reference.example.json reference/reference.json
```

```json
{
  "image": "portrait.jpg",
  "credit": "Photographer name, licence",
  "alt": "Short description for screen readers"
}
```

- `image` is a `.jpg`, `.png` or `.webp` file name inside this folder.
- `credit` shows under the reference in the studio. Use a new line for a second line.
- The canvas is 3:4 (810 × 1080). A 3:4 portrait crop lines up with the canvas one to one.

Everything here except this README and the example is git-ignored, so your photos stay local.
Each session records the reference it was painted from, so replays keep showing the right one.
