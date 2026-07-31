/**
 * Cloudflare Worker - 腾讯文档 CORS 代理
 *
 * 部署步骤（2分钟）：
 * 1. 访问 https://dash.cloudflare.com 注册/登录（免费）
 * 2. 左侧菜单 → Workers & Pages → Create application → Create Worker
 * 3. 给 Worker 起名（如 vr-proxy）→ 点击 Deploy
 * 4. 点击 "Edit code" → 删除默认代码 → 粘贴本文件全部内容 → Save and deploy
 * 5. 复制 Worker 地址（如 https://vr-proxy.xxx.workers.dev）
 * 6. 打开 js/sync.js → 找到 PROXY_URL 变量 → 替换为你的 Worker 地址
 *
 * 原理：浏览器无法直接请求腾讯文档API（CORS限制+Referer头禁止设置），
 *       Worker在服务端转发请求并添加Referer头，同时返回CORS响应头。
 */

export default {
  async fetch(request) {
    // 处理 CORS 预检请求
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // 从查询参数获取目标 URL
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get("url");

    if (!targetUrl) {
      return new Response(
        JSON.stringify({ error: "Missing 'url' parameter" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // 验证目标 URL 是腾讯文档 API
    if (!targetUrl.startsWith("https://docs.qq.com/")) {
      return new Response(
        JSON.stringify({ error: "Only docs.qq.com URLs are allowed" }),
        {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    try {
      // 转发请求，添加必要的请求头
      const resp = await fetch(targetUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "application/json, text/plain, */*",
          Referer: "https://docs.qq.com/sheet/DYk1EZUJBQmR0dmJa",
        },
      });

      // 获取响应内容
      const data = await resp.text();

      // 返回带有 CORS 头的响应
      return new Response(data, {
        status: resp.status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        },
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: "Proxy fetch failed: " + e.message }),
        {
          status: 502,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
  },
};
