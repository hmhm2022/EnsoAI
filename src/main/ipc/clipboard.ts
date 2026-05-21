import { Buffer } from 'node:buffer';
import { type ClipboardImageResult, IPC_CHANNELS } from '@shared/types';
import { clipboard, ipcMain } from 'electron';

export function registerClipboardHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.CLIPBOARD_READ_IMAGE, async (): Promise<ClipboardImageResult> => {
    try {
      const image = clipboard.readImage();
      if (image.isEmpty()) {
        return { success: false, reason: 'empty' };
      }

      const pngBuffer = image.toPNG();
      if (!pngBuffer || pngBuffer.length === 0) {
        return { success: false, reason: 'empty' };
      }

      const timestamp = Date.now();
      return {
        success: true,
        mime: 'image/png',
        data: Uint8Array.from(Buffer.from(pngBuffer)),
        filename: `clipboard-${timestamp}.png`,
      };
    } catch (error) {
      return {
        success: false,
        reason: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
