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

export function scanSource(): ScanSource {
  if (Capacitor.isNativePlatform()) return 'native';
  if (typeof window !== 'undefined' && window.BarcodeDetector) return 'detector';
  return 'zxing';
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

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    if (stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return { stop };
    }
    video.srcObject = stream;
    await video.play();
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error('Camera unavailable'));
    return { stop };
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
    return { stop };
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
    };
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error('Barcode decoding unavailable'));
    return { stop };
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

  const photo = await Camera.getPhoto({ quality: 85, resultType: 'uri' as never, source: 'CAMERA' as never });
  if (!photo?.path) return null;

  const { blocks } = await TextRecognition.processImage({ path: photo.path });
  return blocks.map((block) => block.text);
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

const LABEL_PATTERNS: { key: keyof ParsedLabel; pattern: RegExp; scale?: number }[] = [
  { key: 'kcal', pattern: /(?:energy|calories|kcal)\D{0,20}?(\d+(?:[.,]\d+)?)\s*(?:kcal)?/i },
  { key: 'protein', pattern: /protein\D{0,20}?(\d+(?:[.,]\d+)?)\s*g/i },
  { key: 'carbs', pattern: /carbohydrate\D{0,20}?(\d+(?:[.,]\d+)?)\s*g/i },
  { key: 'sugar', pattern: /(?:of which )?sugars?\D{0,20}?(\d+(?:[.,]\d+)?)\s*g/i },
  { key: 'fat', pattern: /(?:total )?fat\D{0,20}?(\d+(?:[.,]\d+)?)\s*g/i },
  { key: 'satFat', pattern: /satur\w*\D{0,20}?(\d+(?:[.,]\d+)?)\s*g/i },
  { key: 'fiber', pattern: /fib(?:re|er)\D{0,20}?(\d+(?:[.,]\d+)?)\s*g/i },
  { key: 'sodiumMg', pattern: /sodium\D{0,20}?(\d+(?:[.,]\d+)?)\s*mg/i },
  { key: 'servingG', pattern: /serving size\D{0,20}?(\d+(?:[.,]\d+)?)\s*g/i },
];

/**
 * Pull nutrition figures out of recognised label text. Deliberately
 * conservative: anything it cannot read confidently is left blank for the user
 * to fill, because a wrong number entered silently is worse than a blank field.
 */
export function parseNutritionLabel(lines: string[]): ParsedLabel {
  const text = lines.join('\n');
  const out: ParsedLabel = {};

  for (const { key, pattern, scale = 1 } of LABEL_PATTERNS) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    const value = Number(match[1].replace(',', '.'));
    if (Number.isFinite(value)) out[key] = value * scale;
  }

  // Salt is the European convention; convert to the sodium FuelFlow stores.
  if (out.sodiumMg === undefined) {
    const salt = /salt\D{0,20}?(\d+(?:[.,]\d+)?)\s*g/i.exec(text);
    if (salt?.[1]) out.sodiumMg = Number(salt[1].replace(',', '.')) * 400;
  }

  // Labels outside the US often give kilojoules only.
  if (out.kcal === undefined) {
    const kj = /(\d+(?:[.,]\d+)?)\s*kj/i.exec(text);
    if (kj?.[1]) out.kcal = Number(kj[1].replace(',', '.')) / 4.184;
  }
  return out;
}
