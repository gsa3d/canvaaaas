# canvaaaas

[Русская версия](README.ru.md)

A desktop editor for large illustrations, one piece at a time. Select an area, describe what should be there, and a generative model redraws just that area. Everything outside the selection stays byte-for-byte untouched.

- **Big images.** 8000×6000 and larger: tiled canvas, all pixel work happens in the app, not in a browser canvas.
- **Precise edits.** The model sees a crop around your selection, its answer is pasted back through your mask with a soft edge. Models that don't accept masks still edit only what you selected.
- **Two image models.** Nano Banana 2 and Nano Banana Pro (Gemini image) with a [laozhang.ai](https://laozhang.ai) API key, or ChatGPT Images on your ChatGPT subscription through Codex — no API key.
- **Layers and versions.** Every result is a version of a layer: switch between them, compare, hide, regroup, merge, edit a layer mask with a brush.
- **Object selection.** The Wand selects objects with SAM 2.1, which runs locally on your computer.
- **Director and critic.** Optionally, ChatGPT writes out a detailed task from your words and the picture, and the edit goes in steps: after each, a critic says what to fix.
- **Sketch and references.** Draw a rough sketch of where things go; add up to three reference images per edit; set a style for the whole document.

The interface is in English, or in Russian when your system language is Russian (switch it in Settings).

## Download

Get the latest version on the [Releases](https://github.com/gsa3d/canvaaaas/releases/latest) page.

| System | File |
| --- | --- |
| macOS 12 or later, Apple Silicon (M1 and newer) | `canvaaaas-<version>-mac-arm64.dmg` |
| Windows 10 or 11, 64-bit | `canvaaaas-<version>-windows-x64-setup.exe` |

Intel Macs and Linux are not supported yet.

### macOS

1. Open the `.dmg` and drag **canvaaaas** to **Applications**.
2. The app is not notarized by Apple, so on the first launch macOS refuses to open it. Either open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to canvaaaas, or run this in Terminal once:

   ```bash
   xattr -dr com.apple.quarantine /Applications/canvaaaas.app
   ```

### Windows

Run the installer. It installs canvaaaas for your user only, no administrator rights needed. The installer is not code-signed, so Windows SmartScreen may show *Windows protected your PC*: click **More info → Run anyway**.

## Setup

canvaaaas needs at least one image model. Open **Settings** (⌘, on macOS, Ctrl+, on Windows).

**Nano Banana 2 / Nano Banana Pro.** Create an API key at [laozhang.ai](https://laozhang.ai) and paste it into Settings. The key is stored in the macOS Keychain or, on Windows, encrypted for your user account; it is only ever sent to laozhang.ai. Each generation is billed by laozhang.ai.

**ChatGPT Images.** No key: images are drawn by Codex signed in to your ChatGPT account, and generations count toward your ChatGPT plan limits. On macOS, install the [ChatGPT desktop app](https://chatgpt.com/download) (it includes Codex) or [Codex CLI](https://github.com/openai/codex). On Windows, install Codex CLI — `npm install -g @openai/codex` or the installer from its page — and sign in with `codex login`. Settings shows where canvaaaas found Codex. The Director and the critic also run through Codex.

**Object selection.** The first time you use the Wand, canvaaaas offers to download the SAM 2.1 model (272 MB, once). It runs on your computer, offline and free.

## How to use

1. **Open** an image (⌘O): PNG, JPEG, WebP, TIFF or a canvaaaas project (`.caaa`). Or create a **New canvas** (⌘N).
2. **Select** what to change: the Wand (W) picks an object under the click, or use the Rectangle (R), Lasso (L) or Brush (B). Shift adds to the selection, Alt subtracts. The dashed frame shows the crop the model will see.
3. **Describe the result** in the edit panel — what should be there, not what to fix. Optionally add a **Sketch** (S), **References** (drag, paste or pick up to three images) and a document **Style**.
4. Pick the model, resolution and number of variants, then **Generate** (⌘↵). The button says where the result will go and how many generations it costs.
5. Each result becomes a **version** of a layer. Switch versions in the strip under the canvas (← →), hover a version to preview it, press F to zoom to the crop.
6. Fix the edges: click the mask thumbnail next to a layer to hide or bring back parts with the brush, or use **Mask → By edit** to grow the mask over what the model drew beyond the selection. **Revise task** and **More** generate new versions of the same layer.
7. **Save** (⌘S). A `.caaa` project keeps all layers and versions. Saving to an image merges what is visible; **Export Image** (⇧⌘E) writes a copy and keeps the project as is.

More options in the edit panel:

- **Director** — ChatGPT first writes out the task, and the edit goes in steps with a critic until it says the result is done.
- **Object mask** — the model also draws a mask of the new object for every version, so the layer is exactly the object.
- **From scratch** — the model gets the selected area filled with gray and draws it anew instead of reworking what was there.

Useful keys: ⌘Z / ⇧⌘Z undo and redo, ⌘D deselect, ⌘J layer via copy, ⇧⌘J layer via cut, ⌘G group, ⌘E merge, H or Space to pan, ⌘0 fit to window, ⌘1 100%, hold `\` to see the original picture.

### Prompt tips

- Describe the result, not the problem: not "fix the broken rails", but "the rails on the bridge continue the track from the left, without a gap, with the same sleepers".
- Select only the place that should change, with a small margin. When the crop is much larger than the model's output, it loses detail — the resolution hint in the edit panel warns about it.
- For edits that need reasoning (perspective, matching details), try Nano Banana Pro: it is slower and pricier, but thinks better.

### Saving

The canvas inside canvaaaas is 8-bit sRGB without transparency. If the original file is different — has transparency, 16 bits per channel, a Display P3 or Adobe RGB profile, CMYK, or is a TIFF that may hold Photoshop layers — **Save** will not overwrite it and asks for a new file name instead. PNG and WebP are overwritten losslessly; JPEG is re-encoded at quality 95 on every save, so for long work keep a PNG or `.caaa` copy.

## Privacy and costs

- canvaaaas runs on your computer. Its built-in server listens only on 127.0.0.1.
- Only the crop around your selection (with your sketch and references) is sent to the model you chose: laozhang.ai for Nano Banana, OpenAI through Codex for ChatGPT Images.
- Every generation costs money or subscription quota. The counter in the top bar shows generations for this session and today; all calls are logged to `generations.jsonl` in the app data folder (`~/Library/Application Support/canvaaaas` on macOS, `%APPDATA%\canvaaaas` on Windows).

## Build from source

You need [Node.js](https://nodejs.org) 22.18 or newer.

```bash
npm install
```

```bash
npm start
```

`npm start` builds the app and opens it in Electron. Installers: `npm run dist:mac` (on a Mac with Apple Silicon) and `npm run dist:win` (on Windows, or on a Mac, where it builds in a copy of the project with the Windows versions of the dependencies in `work/win-build`).

Development in the browser, with a mock model that costs nothing:

```bash
CANVAAAAS_PROVIDER=mock npm run dev
```

Then open http://127.0.0.1:5173. `CANVAAAAS_LANG=en` or `ru` overrides the system language, `CANVAAAAS_OPEN=path/to/image.png` opens a picture on start.

```bash
npm run typecheck
```

```bash
npm test
```

### Command line

```bash
npm run edit-region -- --image big.png --mask mask.png --prompt "add a boat with a red sail" --variants 2 --out result.png
```

The mask is a PNG of the same size: white is what to redraw, black is what to keep. Run it without arguments for all options.

## License

[MIT](LICENSE). canvaaaas is not affiliated with Google, OpenAI or laozhang.ai.

It is built with [Electron](https://www.electronjs.org), [sharp](https://sharp.pixelplumbing.com) and libvips, [ONNX Runtime](https://onnxruntime.ai), [OpenSeadragon](https://openseadragon.github.io), [Preact](https://preactjs.com), [Tabler Icons](https://tabler.io/icons) and the [Golos Text](https://github.com/googlefonts/golos-text) font. Object selection uses [SAM 2.1](https://github.com/facebookresearch/sam2) by Meta (Apache 2.0) in the ONNX build by [AnyLabeling](https://huggingface.co/vietanhdev/segment-anything-2.1-onnx-models).
