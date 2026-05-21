export type ClipboardImageSuccess = {
  success: true;
  mime: 'image/png';
  data: Uint8Array;
  filename: string;
};

export type ClipboardImageFailure = {
  success: false;
  reason: 'empty' | 'error';
  error?: string;
};

export type ClipboardImageResult = ClipboardImageSuccess | ClipboardImageFailure;
