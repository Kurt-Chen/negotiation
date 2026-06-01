import { createWorker } from 'tesseract.js';

export async function recognizeImageText(
  file: File,
  onProgress: (progress: number, status: string) => void
): Promise<string> {
  const worker = await createWorker('chi_sim+eng', 1, {
    logger: (message) => {
      if (message.status) onProgress(message.progress || 0, translateStatus(message.status));
    }
  });

  try {
    const result = await worker.recognize(file);
    return cleanupText(result.data.text);
  } finally {
    await worker.terminate();
  }
}

function cleanupText(text: string) {
  return text
    .replace(/[|]{2,}/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function translateStatus(status: string) {
  const labels: Record<string, string> = {
    'loading tesseract core': '加载识别核心',
    'initializing tesseract': '初始化 OCR',
    'loading language traineddata': '加载中文识别模型',
    'initializing api': '准备识别',
    'recognizing text': '识别截图文字'
  };
  return labels[status] || status;
}
