import { Capacitor } from '@capacitor/core';

/**
 * Barcode scanning, three ways.
 *
 *  - Native  : Google ML Kit through Capacitor. Fast, works in poor light,
 *              entirely on-device, and on Android can use the Play Services
 *              module so nothing extra ships in the app binary.
 *  - Browser : the built-in `BarcodeDetector` where the platform provides it
 *              (Android Chrome, recent Safari) — zero download, native speed.
 *  - Fallback: ZXing compiled to WebAssembly, loaded lazily so the ~200 KB
 *              only reaches people who actually need it.
 *
 * All three resolve to the same thing: a digit string, or null if cancelled.
 */

export type ScanSource = 'native' | 'detector' | 'zxing';

export interface ScannerHandle {
  stop: () => void;
  /** Toggle the torch. Resolves to the state actually achieved. */
  setTorch: (on: boolean) => Promise<boolean>;
  /** Whether this device/stream exposes a torch at all. */
  hasTorch: () => boolean;
}

export type PermissionState = 'granted' | 'denied' | 'prompt' | 'unavailable';

/**
 * Camera permission, asked for explicitly.
 *
 * The scanners previously just called `getUserMedia` and let it fail, which on
 * a permanently denied permission produces a bare error and no way forward —
 * the user cannot re-prompt, because the browser and the OS both remember the
 * refusal. Checking first lets the UI explain the situation and offer the only
 * thing that actually works: opening system settings.
 */
export async function cameraPermission(): Promise<PermissionState> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');
      const status = await BarcodeScanner.checkPermissions();
      if (status.camera === 'granted' || status.camera === 'limited') return 'granted';
      if (status.camera === 'denied') return 'denied';
      return 'prompt';
    } catch {
      return 'unavailable';
    }
  }

  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return 'unavailable';
  // The Permissions API knows the answer without lighting up the camera, but
  // Safari does not implement the "camera" name, so an unknown result simply
  // means "we will find out when we ask".
  try {
    const status = await navigator.permissions?.query({ name: 'camera' as PermissionName });
    if (status?.state === 'granted') return 'granted';
    if (status?.state === 'denied') return 'denied';
  } catch {
    /* Not supported here; fall through to prompting. */
  }
  return 'prompt';
}

/** Ask for camera access. Returns the resulting state. */
export async function requestCameraPermission(): Promise<PermissionState> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');
      const status = await BarcodeScanner.requestPermissions();
      return status.camera === 'granted' || status.camera === 'limited' ? 'granted' : 'denied';
    } catch {
      return 'unavailable';
    }
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    // Release it immediately: this call exists to trigger the prompt, and the
    // scanner opens its own stream with the constraints it actually wants.
    stream.getTracks().forEach((track) => track.stop());
    return 'granted';
  } catch (error) {
    return error instanceof DOMException && error.name === 'NotAllowedError' ? 'denied' : 'unavailable';
  }
}

/**
 * Open the OS settings page for this app, the only route back once a
 * permission has been permanently denied.
 */
export async function openAppSettings(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const { NativeSettings, AndroidSettings, IOSSettings } = await import('capacitor-native-settings');
    await NativeSettings.open({
      optionAndroid: AndroidSettings.ApplicationDetails,
      optionIOS: IOSSettings.App,
    });
    return true;
  } catch {
    return false;
  }
}

interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string; format: string }[]>;
}

declare global {
  interface Window {
    BarcodeDetector?: {
      new (options?: { formats?: string[] }): BarcodeDetectorLike;
      getSupportedFormats?: () => Promise<string[]>;
    };
  }
}

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'itf'];

/**
 * Which decoder to drive the in-app viewfinder with.
 *
 * Native no longer means "hand off to ML Kit's own screen". That screen is
 * Google's, complete with its four coloured brackets and a "Scanned by Google"
 * footer, and it replaces the app wholesale — the one moment the product looks
 * least like itself. The WebView's getUserMedia works on Android (the label
 * scanner's preview proves it), so the app keeps its own HUD and decodes in
 * page. `scanNative` remains as the fallback for a device that refuses the
 * camera to the WebView.
 */
export function scanSource(): ScanSource {
  if (typeof window !== 'undefined' && window.BarcodeDetector) return 'detector';
  return 'zxing';
}

/** True where ML Kit's own scanner screen is available as a fallback. */
export function hasNativeScannerFallback(): boolean {
  return Capacitor.isNativePlatform();
}

/** Native scan. Opens ML Kit's own full-screen camera UI. */
export async function scanNative(): Promise<string | null> {
  const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');

  const permission = await BarcodeScanner.requestPermissions();
  if (permission.camera !== 'granted' && permission.camera !== 'limited') {
    throw new Error('Camera permission denied');
  }

  // Android can fetch the scanner module from Play Services rather than
  // bundling it, which keeps the APK small. It is a no-op elsewhere.
  if (Capacitor.getPlatform() === 'android') {
    const available = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
    if (!available.available) {
      await BarcodeScanner.installGoogleBarcodeScannerModule().catch(() => undefined);
    }
  }

  const { barcodes } = await BarcodeScanner.scan();
  return barcodes[0]?.rawValue ?? null;
}

/**
 * Web scan against a `<video>` element the caller owns and renders. Returns a
 * handle so the caller can tear the camera down on unmount — a scanner left
 * running is a battery and privacy problem.
 */
export async function scanFromVideo(
  video: HTMLVideoElement,
  onResult: (barcode: string) => void,
  onError?: (error: Error) => void,
): Promise<ScannerHandle> {
  let stopped = false;
  let stream: MediaStream | null = null;

  const stop = () => {
    stopped = true;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
  };

  /**
   * Torch lives on the video track, not on the camera as a whole, and is an
   * optional constraint — plenty of devices and every desktop webcam simply do
   * not have one, so support is probed rather than assumed.
   */
  const track = () => stream?.getVideoTracks()[0] ?? null;
  const hasTorch = () => {
    const capabilities = track()?.getCapabilities?.() as { torch?: boolean } | undefined;
    return capabilities?.torch === true;
  };
  const setTorch = async (on: boolean) => {
    const videoTrack = track();
    if (!videoTrack || !hasTorch()) return false;
    try {
      // `torch` is a real constraint on Android/Chrome but is absent from the
      // DOM typings, so the cast goes via unknown rather than pretending it is
      // a known member.
      await videoTrack.applyConstraints({ advanced: [{ torch: on }] } as unknown as MediaTrackConstraints);
      return on;
    } catch {
      return false;
    }
  };
  const idle: ScannerHandle = { stop, setTorch: async () => false, hasTorch: () => false };

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    if (stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return idle;
    }
    video.srcObject = stream;
    await startPlayback(video);
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error('Camera unavailable'));
    return idle;
  }

  if (window.BarcodeDetector) {
    const detector = new window.BarcodeDetector({ formats: FORMATS });
    const tick = async () => {
      if (stopped) return;
      try {
        const results = await detector.detect(video);
        const hit = results.find((r) => /^\d{6,14}$/.test(r.rawValue));
        if (hit) {
          onResult(hit.rawValue);
          return;
        }
      } catch {
        // A transient decode failure is normal between frames.
      }
      requestAnimationFrame(() => void tick());
    };
    void tick();
    return { stop, setTorch, hasTorch };
  }

  // ZXing is imported here rather than at module scope so the WebAssembly
  // payload never lands in the main bundle.
  try {
    const { BrowserMultiFormatReader } = await import('@zxing/browser');
    const reader = new BrowserMultiFormatReader();
    const controls = await reader.decodeFromVideoElement(video, (result) => {
      if (stopped || !result) return;
      const text = result.getText();
      if (/^\d{6,14}$/.test(text)) onResult(text);
    });
    return {
      stop: () => {
        controls.stop();
        stop();
      },
      setTorch,
      hasTorch,
    };
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error('Barcode decoding unavailable'));
    return idle;
  }
}

/**
 * On-device nutrition-label text recognition. Native only: ML Kit runs the
 * model locally with nothing leaving the device. The web build deliberately has
 * no OCR rather than shipping a multi-megabyte model or posting label photos to
 * a third-party service.
 */
export async function recognizeLabelText(): Promise<string[] | null> {
  if (!Capacitor.isNativePlatform()) return null;
  const { TextRecognition } = await import('@capacitor-mlkit/text-recognition');
  const { Camera } = await import('@capacitor/camera').catch(() => ({ Camera: null }) as never);
  if (!Camera) return null;

  // Ask before opening the camera so a refusal surfaces as a state the UI can
  // explain, rather than as an opaque failure from getPhoto.
  const status = await Camera.checkPermissions().catch(() => null);
  if (status && status.camera !== 'granted' && status.camera !== 'limited') {
    const requested = await Camera.requestPermissions({ permissions: ['camera'] }).catch(() => null);
    if (!requested || (requested.camera !== 'granted' && requested.camera !== 'limited')) {
      throw new CameraDeniedError();
    }
  }

  // The system camera is used here rather than an in-app preview, so its own
  // flash control is available and no torch handling is needed.
  const photo = await Camera.getPhoto({ quality: 85, resultType: 'uri' as never, source: 'CAMERA' as never });
  if (!photo?.path) return null;

  const { blocks } = await TextRecognition.processImage({ path: photo.path });
  return blocks.map((block) => block.text);
}

/**
 * A single black pixel, used as the poster on every viewfinder.
 *
 * Between mount and the camera handing over its first frame, a `<video>` with
 * no source is "broken media" as far as the Android WebView is concerned, and
 * it paints its own placeholder: a grey panel with a large play triangle. That
 * is the artifact that flashed up every time a scanner opened.
 *
 * Fading the element in on `loadeddata` did not suppress it. A media element is
 * composited on its own layer, and the placeholder is drawn by the WebView
 * rather than by the page, so it is not reliably subject to the page's opacity.
 * A poster is: the WebView shows it in place of the placeholder, and one black
 * pixel stretched over a black screen is nothing at all.
 */
export const VIDEO_POSTER =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * Start playback without letting a cancelled play() look like a camera failure.
 *
 * `HTMLMediaElement.play()` returns a promise that rejects with AbortError
 * whenever anything disturbs the element before the first frame — a re-render
 * that touches it, the element being moved in the tree, a second `play()`. None
 * of that means the camera is unavailable, but the rejection was propagating
 * out of `getUserMedia`'s try block and putting the scanner into its hard error
 * state: "Cannot use the camera — the play() request was interrupted".
 *
 * The element also carries `autoplay`, so if this attempt is cancelled the
 * browser starts the stream itself as soon as it settles. The only failure
 * worth reporting is one from `getUserMedia`, which has already happened by the
 * time we get here.
 */
async function startPlayback(video: HTMLVideoElement): Promise<void> {
  try {
    await video.play();
  } catch (error) {
    if ((error as Error)?.name === 'AbortError' || (error as Error)?.name === 'NotAllowedError') return;
    throw error;
  }
}

/**
 * Grabs the current video frame as a JPEG data URL.
 *
 * Downscaled to a sane width first: a full-resolution phone frame is several
 * megabytes of base64 to shuttle across the bridge, and OCR gains nothing from
 * the extra pixels — label text is large and high-contrast.
 */
export function captureFrame(video: HTMLVideoElement, maxWidth = 1440): string | null {
  const { videoWidth, videoHeight } = video;
  if (!videoWidth || !videoHeight) return null;
  const scale = Math.min(1, maxWidth / videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(videoWidth * scale);
  canvas.height = Math.round(videoHeight * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.92);
}

/**
 * On-device OCR over a frame the app captured itself.
 *
 * ML Kit reads from a file path, so the frame is written to the cache directory
 * and deleted immediately afterwards — the photograph of your food never
 * outlives the read, and nothing leaves the device either way.
 */
export async function recognizeLabelFromDataUrl(
  dataUrl: string,
): Promise<{ lines: PositionedLine[]; text: string[] } | null> {
  if (!Capacitor.isNativePlatform()) return null;
  const { TextRecognition } = await import('@capacitor-mlkit/text-recognition');
  const { Filesystem, Directory } = await import('@capacitor/filesystem');

  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const name = `ff-label-${Date.now()}.jpg`;
  const written = await Filesystem.writeFile({
    path: name,
    data: base64,
    directory: Directory.Cache,
  });
  try {
    const { blocks } = await TextRecognition.processImage({ path: written.uri });

    // Positions are kept, not discarded. A nutrition panel is a two-column
    // table and ML Kit hands back the two columns as separate blocks, so the
    // only way to know which figure belongs to which nutrient is where each
    // one sat on the packet.
    const lines: PositionedLine[] = [];
    for (const block of blocks) {
      for (const line of block.lines ?? []) {
        const points = (line as { cornerPoints?: number[][] }).cornerPoints;
        if (!points || points.length === 0) continue;
        const ys = points.map((p) => p[1] ?? 0);
        const xs = points.map((p) => p[0] ?? 0);
        const top = Math.min(...ys);
        const bottom = Math.max(...ys);
        lines.push({
          text: line.text,
          y: (top + bottom) / 2,
          x: Math.min(...xs),
          height: Math.max(1, bottom - top),
        });
      }
    }

    return { lines, text: blocks.map((block) => block.text) };
  } finally {
    await Filesystem.deleteFile({ path: name, directory: Directory.Cache }).catch(() => {});
  }
}

/**
 * Opens a plain camera preview for the label scanner — no decoding loop, just
 * frames to look at until the user presses the shutter.
 */
export async function openCameraPreview(
  video: HTMLVideoElement,
): Promise<ScannerHandle> {
  const state = await cameraPermission();
  if (state === 'denied') throw new CameraDeniedError();

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
  video.srcObject = stream;
  await startPlayback(video);

  const track = () => stream.getVideoTracks()[0] ?? null;
  const hasTorch = () => {
    const capabilities = track()?.getCapabilities?.() as { torch?: boolean } | undefined;
    return capabilities?.torch === true;
  };
  return {
    stop: () => {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
    hasTorch,
    setTorch: async (on: boolean) => {
      const videoTrack = track();
      if (!videoTrack || !hasTorch()) return false;
      try {
        await videoTrack.applyConstraints({
          advanced: [{ torch: on }],
        } as unknown as MediaTrackConstraints);
        return on;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Validates the modulo-10 check digit shared by EAN-8, UPC-A, EAN-13 and
 * GTIN-14.
 *
 * Every one of those formats ends in a digit computed from the ones before it:
 * walking right to left from the digit before it, each is weighted 3, 1, 3, 1
 * and the total must bring the sum to a multiple of ten. A misread barcode
 * almost never satisfies that, so this catches a bad decode locally instead of
 * spending a network round trip to be told the product does not exist — and it
 * lets the scanner keep looking rather than reporting a false "not found".
 *
 * Adapted from OpenNutriTracker (github.com/simonoppowa/OpenNutriTracker).
 */
export function isValidBarcode(code: string): boolean {
  if (!/^\d+$/.test(code)) return false;
  if (![8, 12, 13, 14].includes(code.length)) return false;

  const digits = [...code].map(Number);
  const check = digits[digits.length - 1]!;

  let sum = 0;
  for (let i = digits.length - 2, weightIsThree = true; i >= 0; i--, weightIsThree = !weightIsThree) {
    sum += digits[i]! * (weightIsThree ? 3 : 1);
  }

  return (10 - (sum % 10)) % 10 === check;
}

/** Thrown when the camera is refused, so callers can offer a settings link. */
export class CameraDeniedError extends Error {
  constructor() {
    super('Camera access was refused.');
    this.name = 'CameraDeniedError';
  }
}

// ---------------------------------------------------------------------------
// Label parsing
// ---------------------------------------------------------------------------

export interface ParsedLabel {
  servingG?: number;
  kcal?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  fiber?: number;
  sugar?: number;
  satFat?: number;
  sodiumMg?: number;
}

/**
 * The words each nutrient goes by, across the languages an EU label carries.
 *
 * A pack sold in Greece prints its table in three or four languages at once,
 * and OCR returns all of them interleaved. Matching only the English word meant
 * a line reading "Λιπαρά / Fat / Grassi 12,3 g" was found only if "Fat" landed
 * near enough to the number — and on a multi-column layout it usually did not.
 * Every synonym is tried, so whichever language sits closest to the figure wins.
 *
 * Greek is included even though ML Kit's Latin recogniser cannot read Greek
 * script: these also match text typed by hand, and a label whose Greek column
 * happens to be transliterated still parses.
 */
const NUTRIENT_WORDS: Record<string, string[]> = {
  protein: ['protein', 'proteine', 'proteines', 'proteinas', 'eiweiss', 'eiwit', 'πρωτε'],
  carbs: [
    'carbohydrate',
    'carbohydrates',
    'glucides',
    'kohlenhydrate',
    'carboidrati',
    'hidratos de carbono',
    'koolhydraten',
    'υδατ',
  ],
  sugar: ['sugars', 'sugar', 'sucres', 'zucker', 'zuccheri', 'azucares', 'suikers', 'σακχαρ'],
  fat: ['total fat', 'fat', 'lipides', 'matieres grasses', 'fett', 'grassi', 'grasas', 'vetten', 'λιπαρ'],
  satFat: [
    'saturates',
    'saturated',
    'satures',
    'gesattigte',
    'saturi',
    'saturadas',
    'verzadigde',
    'κορεσμ',
  ],
  fiber: ['fibre', 'fiber', 'fibres', 'ballaststoffe', 'fibre alimentari', 'vezels', 'εδωδιμ', 'ινωδ'],
};

/** `fat` -> /(?:fat|lipides|...)[^\d\n]{0,24}?(number)\s*g/i */
function nutrientPattern(key: keyof typeof NUTRIENT_WORDS): RegExp {
  const words = NUTRIENT_WORDS[key]!.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // `[^\d\n]` rather than `\D`: it must not cross a line, or a nutrient with no
  // value of its own would capture the number from the row beneath it.
  return new RegExp(`(?:${words})[^\\d\\n]{0,24}?(\\d+(?:[.,]\\d+)?)\\s*g`, 'i');
}

const LABEL_PATTERNS: { key: keyof ParsedLabel; pattern: RegExp; scale?: number }[] = [
  { key: 'protein', pattern: nutrientPattern('protein') },
  { key: 'carbs', pattern: nutrientPattern('carbs') },
  { key: 'sugar', pattern: nutrientPattern('sugar') },
  { key: 'fat', pattern: nutrientPattern('fat') },
  { key: 'satFat', pattern: nutrientPattern('satFat') },
  { key: 'fiber', pattern: nutrientPattern('fiber') },
  { key: 'sodiumMg', pattern: /(?:sodium|natrium|sodio)[^\d\n]{0,24}?(\d+(?:[.,]\d+)?)\s*mg/i },
  // `[^\n]` rather than `\D`: US panels write "Serving size 2/3 cup (55g)", and
  // a non-digit class cannot step over the "2/3" to reach the grams.
  { key: 'servingG', pattern: /serving size[^\n]{0,40}?(\d+(?:[.,]\d+)?)\s*g\b/i },
];

const toNumber = (raw: string) => Number(raw.replace(',', '.'));

/**
 * Energy, read in order of how unambiguous each form is.
 *
 * European labels print both units on one line — "Energy 2255 kJ / 539 kcal" —
 * so a pattern anchored on the *word* "energy" takes whichever number comes
 * first and records the kilojoules as calories, overstating by 4.2x. Anchoring
 * on the unit instead means each number is read as what it is labelled.
 */
function readEnergyKcal(text: string): number | undefined {
  // "539 kcal" — unit after its own number.
  const kcalAfter = /(\d+(?:[.,]\d+)?)\s*kcal\b/i.exec(text);
  if (kcalAfter?.[1]) return toNumber(kcalAfter[1]);

  // "kcal 539" — some tables put the unit in a header column.
  const kcalBefore = /kcal\D{0,10}?(\d+(?:[.,]\d+)?)/i.exec(text);
  if (kcalBefore?.[1]) return toNumber(kcalBefore[1]);

  // US panels give a bare number: "Calories 230".
  const calories = /calories\D{0,20}?(\d+(?:[.,]\d+)?)/i.exec(text);
  if (calories?.[1]) return toNumber(calories[1]);

  // Kilojoule-only labels, converted last.
  const kj = /(\d+(?:[.,]\d+)?)\s*kj\b/i.exec(text);
  if (kj?.[1]) return toNumber(kj[1]) / 4.184;

  return undefined;
}

/** One recognised line, with where it sat on the packet. */
export interface PositionedLine {
  text: string;
  /** Vertical centre, in image pixels. */
  y: number;
  /** Left edge, in image pixels. */
  x: number;
  height: number;
}

/**
 * Reads a nutrition table using where the text actually sits.
 *
 * A nutrition panel is a two-column table, and OCR does not return it as one:
 * ML Kit groups the label column and the figures column into separate blocks,
 * so flattening to text puts every name first and every number last —
 *
 *     Λιπαρά/Fat
 *     εκ των οποίων Κορεσμένα/of which Saturates
 *     Πρωτεΐνες/Protein
 *     1g
 *     20g
 *     20g
 *     3g
 *
 * A pattern that expects the number beside its label cannot match any of that,
 * which is why a perfectly legible packet yielded only the energy line: the
 * energy figure is the one that happens to sit inline.
 *
 * Pairing by vertical position instead reconstructs the rows, and the order the
 * blocks arrived in stops mattering.
 */
export function parseLabelLines(lines: PositionedLine[]): ParsedLabel {
  const out: ParsedLabel = {};
  if (lines.length === 0) return out;

  const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // Tokens that are a measurement and nothing else — the figures column.
  // `[g9]` because OCR reads a lone "0g" as "09" often enough to matter, and a
  // bare digit pair is never a nutrient value in its own right.
  const VALUE = /^([\d.,]+)\s*(mg|kcal|kj|[g9])\b/i;

  const values = lines
    .map((line) => {
      const match = VALUE.exec(line.text.trim());
      if (!match) return null;
      const unit = match[2]!.toLowerCase() === '9' ? 'g' : match[2]!.toLowerCase();
      return { ...line, value: Number(match[1]!.replace(',', '.')), unit };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null && Number.isFinite(v.value));

  if (values.length === 0) return out;

  /** The measurement sharing a row with this label, if there is one. */
  const valueFor = (label: PositionedLine, unit: 'g' | 'mg') => {
    let best: (typeof values)[number] | undefined;
    let bestDistance = Infinity;
    for (const candidate of values) {
      if (candidate.unit !== unit) continue;
      // A row, not a coincidence: within roughly one line height, and to the
      // right of the label rather than above or below it in another column.
      const distance = Math.abs(candidate.y - label.y);
      if (distance > Math.max(label.height, candidate.height) * 0.9) continue;
      if (candidate.x < label.x) continue;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    return best?.value;
  };

  const findLabel = (words: string[]) =>
    lines.find((line) => {
      const text = strip(line.text);
      return words.some((word) => text.includes(strip(word)));
    });

  for (const [key, words] of Object.entries(NUTRIENT_WORDS) as [
    keyof typeof NUTRIENT_WORDS,
    string[],
  ][]) {
    const label = findLabel(words);
    if (!label) continue;
    const value = valueFor(label, 'g');
    if (value !== undefined) out[key as keyof ParsedLabel] = value;
  }

  // Energy is the one row that usually carries both units — "1080kJ / 260kcal"
  // — and often prints them inline with the label rather than in the figures
  // column. Read the inline form first, then the column, kcal ahead of kJ.
  const energyLabel = findLabel(['energy', 'energie', 'energia', 'ενεργ', 'calories']);
  if (energyLabel) {
    // Everything printed on the energy row, label and figures together. The
    // kcal figure is frequently the *second* number in a cell — "1080kJ /
    // 260kcal" — so reading only the start of each line converted the
    // kilojoules and threw the exact number away.
    const row = lines
      .filter((line) => Math.abs(line.y - energyLabel.y) <= energyLabel.height)
      .map((line) => line.text)
      .join(' ');

    const kcal = /(\d+(?:[.,]\d+)?)\s*kcal/i.exec(row);
    const kj = /(\d+(?:[.,]\d+)?)\s*kj/i.exec(row);

    if (kcal?.[1]) out.kcal = Number(kcal[1].replace(',', '.'));
    else if (kj?.[1]) out.kcal = Number(kj[1].replace(',', '.')) / 4.184;
  }

  // Salt is the European convention; sodium is what the app stores.
  const saltLabel = findLabel(['salt', 'sel', 'sale', 'zout', 'αλατι']);
  if (saltLabel && out.sodiumMg === undefined) {
    const salt = valueFor(saltLabel, 'g');
    if (salt !== undefined) out.sodiumMg = salt * 400;
  }

  return out;
}

/**
 * Pull nutrition figures out of recognised label text. Deliberately
 * conservative: anything it cannot read confidently is left blank for the user
 * to fill, because a wrong number entered silently is worse than a blank field.
 */
export function parseNutritionLabel(lines: string[]): ParsedLabel {
  // Diacritics are stripped before matching so one spelling covers every
  // accented form: "gesättigte" and "gesattigte", "matières" and "matieres",
  // "saturés" and "satures". Listing each variant by hand meant a German label
  // read its fat but not its saturated fat. Only positions of digits are used
  // afterwards, and normalising does not disturb those.
  const text = lines
    .join('\n')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  const out: ParsedLabel = {};

  for (const { key, pattern, scale = 1 } of LABEL_PATTERNS) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    const value = toNumber(match[1]);
    if (Number.isFinite(value)) out[key] = value * scale;
  }

  /*
   * Second pass, for panels printed as prose rather than as a grid.
   *
   * Small jars and sachets have no room for two columns, so the figures run on
   * in a sentence — and OCR wraps that sentence wherever the packet does,
   * leaving "of which sugars" on one line and "56.3 g" on the next. The strict
   * patterns above refuse to cross a newline on purpose: in a *table* that is
   * what stops a nutrient with no value of its own stealing the figure from the
   * row beneath it.
   *
   * So the newlines are removed and the same patterns run again — but only to
   * fill values the strict pass could not find. Anything it did find wins,
   * which keeps the table case exactly as safe as it was.
   */
  const unwrapped = text.replace(/\n+/g, ' ');
  for (const { key, pattern, scale = 1 } of LABEL_PATTERNS) {
    if (out[key] !== undefined) continue;
    const match = pattern.exec(unwrapped);
    if (!match?.[1]) continue;
    const value = toNumber(match[1]);
    if (Number.isFinite(value)) out[key] = value * scale;
  }

  const kcal = readEnergyKcal(text);
  if (kcal !== undefined && Number.isFinite(kcal)) out.kcal = kcal;

  // Salt is the European convention; convert to the sodium FuelFlow stores.
  if (out.sodiumMg === undefined) {
    const salt = /salt\D{0,20}?(\d+(?:[.,]\d+)?)\s*g/i.exec(text);
    if (salt?.[1]) out.sodiumMg = toNumber(salt[1]) * 400;
  }

  return out;
}
