import { fault } from "./controller.mjs";
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
// QQ's image CDN hosts only. Never send bot credentials when fetching an image.
const CDN_HOSTS = new Set(["multimedia.nt.qq.com.cn", "gchat.qpic.cn", "c2cpicdw.qpic.cn", "p.qpic.cn", "q.qlogo.cn"]);
export function imageURL(value) {
  let u; try { u = new URL(value); } catch { throw fault("IMAGE_URL_REJECTED", "图片地址无效。"); }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443") || !CDN_HOSTS.has(u.hostname)) throw fault("IMAGE_URL_REJECTED", "图片来源不是支持的 QQ 图片服务。");
  return u.href;
}
export function imageMetadata(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return [];
  if (attachments.length > MAX_IMAGES) throw fault("IMAGE_COUNT_LIMIT", "每条消息最多支持 4 张图片。");
  return attachments.map(a => {
    const type = typeof a?.content_type === "string" ? a.content_type.toLowerCase().split(";")[0].trim() : "";
    if (!["image/png", "image/jpeg", "image/webp"].includes(type)) throw fault("IMAGE_FORMAT_UNSUPPORTED", "仅支持 PNG、JPEG、WebP 图片，不支持其它附件。");
    if (typeof a.url !== "string" || a.url.length > 8192) throw fault("IMAGE_URL_REJECTED", "图片地址无效。");
    const url = imageURL(a.url);
    if (Number(a.size) > MAX_IMAGE_BYTES) throw fault("IMAGE_TOO_LARGE", "单张图片不能超过 5 MiB。");
    return { url };
  });
}
function extension(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  throw fault("IMAGE_FORMAT_UNSUPPORTED", "下载结果不是 PNG、JPEG 或 WebP 图片。");
}
export async function downloadImages(metadata, fetcher = globalThis.fetch) {
  if (!Array.isArray(metadata) || !metadata.length || metadata.length > MAX_IMAGES) throw fault("IMAGE_COUNT_LIMIT", "图片数量无效。");
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 22000);
  let total = 0;
  try {
    const images = [];
    for (const [index, item] of metadata.entries()) {
      let url = imageURL(item.url), response;
      for (let redirects = 0; redirects <= 3; redirects++) {
        response = await fetcher(url, { redirect: "manual", signal: abort.signal, headers: { Accept: "image/png,image/jpeg,image/webp" } });
        if (![301,302,303,307,308].includes(response.status)) break;
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirects === 3) throw fault("IMAGE_DOWNLOAD_FAILED", "图片重定向失败。");
        url = imageURL(new URL(location, url).href);
      }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw fault("IMAGE_DOWNLOAD_FAILED", "QQ 图片下载失败或地址已过期。"); }
      if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) { await response.body.cancel(); throw fault("IMAGE_TOO_LARGE", "单张图片不能超过 5 MiB。"); }
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; total += value.byteLength;
          if (size > MAX_IMAGE_BYTES || total > MAX_TOTAL_BYTES) { await reader.cancel(); throw fault("IMAGE_TOO_LARGE", "图片超出大小限制。"); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      const buffer = Buffer.concat(chunks, size), ext = extension(buffer);
      images.push({ buffer, name: "qq-image-" + (index + 1) + "." + ext });
    }
    return images;
  } catch (error) {
    if (typeof error.code === "string" && /^IMAGE_[A-Z_]+$/.test(error.code)) throw error;
    throw fault("IMAGE_DOWNLOAD_FAILED", "QQ 图片下载失败，请发送新的图片重试。");
  } finally { clearTimeout(timer); }
}
