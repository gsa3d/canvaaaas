// Общий интерфейс провайдеров генерации: Nano Banana через laozhang по ключу
// и ChatGPT Images по подписке через Codex CLI.

export interface Size {
  width: number;
  height: number;
}

export interface InputImage {
  data: Buffer;
  mimeType: string;
}

export interface GenerateRequest {
  prompt: string;
  images: InputImage[];
  /** Пропорции «ш:в» из списка provider.aspectRatios */
  aspectRatio: string;
  /** Разрешение из списка provider.imageSizes */
  imageSize: string;
  signal?: AbortSignal;
}

export interface GenerateResult {
  image: Buffer;
  mimeType: string;
  model: string;
  elapsedMs: number;
  /** Текст, который модель вернула вместе с картинкой */
  text?: string;
}

export interface ImageProvider {
  readonly id: string;
  readonly model: string;
  /** Поддерживаемые пропорции «ш:в» */
  readonly aspectRatios: readonly string[];
  /** Разрешения от меньшего к большему */
  readonly imageSizes: readonly string[];
  /** Размер картинки, которую модель вернёт на такие пропорции и разрешение */
  outputSize(aspectRatio: string, imageSize: string): Size;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

export class ProviderError extends Error {
  /** HTTP-код ответа, если до ответа дошло */
  readonly status: number | undefined;
  /** Имеет смысл повторить: сеть, 429, 5xx */
  readonly retryable: boolean;

  constructor(message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }
}
