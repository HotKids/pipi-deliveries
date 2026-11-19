export interface PickupOcrBlock {
  readonly text: string
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export interface PickupRecognitionHost {
  readonly packageName?: string
  readonly className?: string
  readonly miniProgramLabel?: string
  readonly pageLabel?: string
  readonly pagePath?: string
}

export interface PickupParseInput {
  readonly blocks: readonly PickupOcrBlock[]
  readonly screenWidth: number
  readonly recognizedAtMs: number
  readonly rawBarcodes?: readonly string[]
  readonly host?: PickupRecognitionHost
}

export interface PickupCredential {
  readonly brandId: string
  readonly brandName: string
  readonly code: string
  readonly productName: string
  readonly merchantName: string
  readonly recognizedAtMs: number
  readonly expiresAtMs: number
  readonly waitTime: string
  readonly status: string
  readonly qrPayload: string
}
