import { fault } from "./controller.mjs";
// Keep every worker response comfortably under the host's 1 MiB stdio limit.
export async function collectImages(node, job, epoch) {
  const info = await node("qq/images", { appId: job.appId, requestId: job.id, groupId: job.groupId, messageId: job.messageId, epoch });
  if (typeof info?.transferId !== "string") throw fault("IMAGE_TRANSFER_INVALID", "图片传输未能开始。");
  try {
    if (!Array.isArray(info.images) || info.images.length !== job.imageCount || info.images.length > 4 || info.images.some(i => !Number.isSafeInteger(i.bytes) || i.bytes < 1 || i.bytes > 5 * 1024 * 1024) || info.images.reduce((n, i) => n + i.bytes, 0) > 20 * 1024 * 1024) throw fault("IMAGE_TRANSFER_INVALID", "图片数量或大小无效。");
    const attachments = [];
    for (let index = 0; index < info.images.length; index++) {
      const image = info.images[index], chunks = []; let offset = 0;
      while (offset < image.bytes) {
        const part = await node("qq/image-chunk", { transferId: info.transferId, index, offset });
        const end = Math.min(offset + 192 * 1024, image.bytes), length = end - offset;
        if (part.offset !== offset || part.nextOffset !== end || part.done !== (end === image.bytes) || typeof part.base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(part.base64) || part.base64.length !== Math.ceil(length / 3) * 4) throw fault("IMAGE_TRANSFER_INVALID", "图片传输不完整。");
        chunks.push(part.base64); offset = end;
      }
      attachments.push({ base64: chunks.join(""), name: /^qq-image-[1-4]\.(png|jpg|webp)$/.test(image.name || "") ? image.name : "qq-image-" + (index + 1) });
    }
    return attachments;
  } finally { await node("qq/images-release", { transferId: info.transferId }).catch(() => {}); }
}
