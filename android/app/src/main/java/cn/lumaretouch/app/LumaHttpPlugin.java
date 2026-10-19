package cn.lumaretouch.app;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/** 只暴露模型 HTTP 传输；不提供文件、系统命令或任意 WebView 权限。 */
@CapacitorPlugin(name = "LumaHttp")
public class LumaHttpPlugin extends Plugin {
    private static final int MAX_REQUEST = 96 * 1024 * 1024;
    private static final int MAX_RESPONSE = 128 * 1024 * 1024;
    private final ExecutorService workers = Executors.newFixedThreadPool(3);
    private final ScheduledExecutorService timer = Executors.newScheduledThreadPool(1);
    private final ConcurrentHashMap<String, Pending> active = new ConcurrentHashMap<>();

    private static class Pending {
        volatile boolean cancelled;
        volatile boolean timedOut;
        volatile HttpURLConnection connection;
        void stop() { cancelled = true; if (connection != null) connection.disconnect(); }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id", "");
        Pending pending = active.get(id);
        if (pending != null) pending.stop();
        call.resolve();
    }

    @PluginMethod
    public void request(PluginCall call) {
        String id = call.getString("id", "");
        JSObject request = call.getObject("request");
        if (id.isEmpty() || id.length() > 100 || request == null || active.size() >= 3) { call.reject("请求不可用"); return; }
        Pending pending = new Pending();
        if (active.putIfAbsent(id, pending) != null) { call.reject("请求不可用"); return; }
        workers.execute(() -> {
            ScheduledFuture<?> deadline = timer.schedule(() -> { pending.timedOut = true; pending.stop(); }, 240, TimeUnit.SECONDS);
            try {
                JSObject response = perform(request, pending);
                if (pending.cancelled) throw new Exception("cancelled");
                call.resolve(response);
            } catch (Exception error) {
                if (pending.timedOut) call.reject("模型服务请求超时，请稍后重试");
                else if (pending.cancelled) call.reject("请求已取消");
                else if (error instanceof IllegalArgumentException) call.reject(error.getMessage());
                else call.reject("无法连接模型服务，请检查服务地址、网络和 API 设置");
            } finally {
                deadline.cancel(false);
                if (pending.connection != null) pending.connection.disconnect();
                active.remove(id);
            }
        });
    }

    private URL validateUrl(String raw) throws Exception {
        URI uri = new URI(raw);
        String host = uri.getHost();
        boolean local = "localhost".equals(host) || "127.0.0.1".equals(host) || "[::1]".equals(host) || "::1".equals(host);
        if (host == null || uri.getUserInfo() != null || !("https".equals(uri.getScheme()) || ("http".equals(uri.getScheme()) && local))) {
            throw new IllegalArgumentException("服务地址须使用 HTTPS，本机服务可使用 HTTP；地址不能包含账号密码");
        }
        return uri.toURL();
    }

    private String quoted(String value) {
        return value.replace("\\", "_").replace("\"", "_").replace("\r", "_").replace("\n", "_");
    }

    private byte[] decodeFile(JSONObject file) {
        String raw = file.optString("base64").replaceFirst("^data:[^;,]+;base64,", "");
        if (raw.length() > MAX_REQUEST * 1.4 || !raw.matches("^[A-Za-z0-9+/]*={0,2}$")) throw new IllegalArgumentException("图片无效或过大");
        return Base64.decode(raw, Base64.DEFAULT);
    }

    private byte[] multipart(JSONObject multipart, String boundary) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        JSONObject fields = multipart.optJSONObject("fields");
        if (fields != null) {
            Iterator<String> keys = fields.keys();
            while (keys.hasNext()) {
                String field = keys.next();
                String value = fields.getString(field);
                output.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + quoted(field) + "\"\r\n\r\n" + value + "\r\n").getBytes(StandardCharsets.UTF_8));
                if (output.size() > MAX_REQUEST) throw new IllegalArgumentException("上传内容超过 96 MB 限制");
            }
        }
        JSONArray files = multipart.optJSONArray("files");
        if (files != null) for (int index = 0; index < files.length(); index++) {
            JSONObject file = files.getJSONObject(index);
            byte[] bytes = decodeFile(file);
            if (output.size() + bytes.length > MAX_REQUEST) throw new IllegalArgumentException("上传内容超过 96 MB 限制");
            String mime = file.optString("mimeType", "application/octet-stream");
            if (!mime.matches("^[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+$")) throw new IllegalArgumentException("图片格式无效");
            output.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + quoted(file.getString("field")) + "\"; filename=\"" + quoted(file.optString("name", "image.png")) + "\"\r\nContent-Type: " + mime + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            output.write(bytes); output.write("\r\n".getBytes(StandardCharsets.UTF_8));
        }
        output.write(("--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        return output.toByteArray();
    }

    private JSObject perform(JSObject req, Pending pending) throws Exception {
        URL url = validateUrl(req.getString("url"));
        String method = req.optString("method", "GET");
        if (!method.equals("GET") && !method.equals("POST")) throw new IllegalArgumentException("不支持的请求方法");
        Map<String, String> headers = new HashMap<>();
        JSONObject sourceHeaders = req.optJSONObject("headers");
        if (sourceHeaders != null) {
            Iterator<String> keys = sourceHeaders.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                String value = sourceHeaders.getString(key);
                if (!key.matches("^[A-Za-z0-9-]+$") || value.contains("\r") || value.contains("\n")) throw new IllegalArgumentException("请求头格式无效");
                if (key.matches("(?i)host|connection|cookie|content-length|proxy-authorization")) throw new IllegalArgumentException("不允许的请求头");
                headers.put(key, value);
            }
        }
        byte[] body = null;
        JSONObject multipart = req.optJSONObject("multipart");
        if (multipart != null) {
            String boundary = "Luma" + UUID.randomUUID().toString().replace("-", "");
            body = multipart(multipart, boundary);
            headers.keySet().removeIf(key -> key.equalsIgnoreCase("content-type"));
            headers.put("Content-Type", "multipart/form-data; boundary=" + boundary);
        } else if (req.has("body")) body = req.getString("body").getBytes(StandardCharsets.UTF_8);
        if (body != null && (body.length > MAX_REQUEST || !method.equals("POST"))) throw new IllegalArgumentException("请求内容过大或方法无效");

        for (int redirects = 0; redirects <= 3; redirects++) {
            if (pending.cancelled) throw new Exception("cancelled");
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            pending.connection = connection;
            connection.setConnectTimeout(30000);
            connection.setReadTimeout(240000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod(method);
            connection.setUseCaches(false);
            for (Map.Entry<String, String> header : headers.entrySet()) connection.setRequestProperty(header.getKey(), header.getValue());
            if (body != null) {
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream stream = connection.getOutputStream()) { stream.write(body); }
            }
            int status = connection.getResponseCode();
            if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                String location = connection.getHeaderField("Location");
                connection.disconnect();
                if (!method.equals("GET") || location == null || redirects == 3) throw new IllegalArgumentException("服务发生重定向，请填写最终 API 地址");
                URL next = validateUrl(new URL(url, location).toString());
                if (!url.getProtocol().equals(next.getProtocol()) || !url.getAuthority().equals(next.getAuthority())) headers.clear();
                url = next; continue;
            }
            if (connection.getContentLengthLong() > MAX_RESPONSE) throw new IllegalArgumentException("服务返回内容超过 128 MB 限制");
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            InputStream raw = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (raw != null) try (InputStream input = raw) {
                byte[] buffer = new byte[32768]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (pending.cancelled) throw new Exception("cancelled");
                    if (output.size() + count > MAX_RESPONSE) throw new IllegalArgumentException("服务返回内容超过 128 MB 限制");
                    output.write(buffer, 0, count);
                }
            }
            JSObject response = new JSObject();
            response.put("status", status);
            response.put("body", "base64".equals(req.optString("responseType")) ? Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP) : output.toString("UTF-8"));
            response.put("contentType", connection.getContentType());
            return response;
        }
        throw new IllegalArgumentException("服务重定向次数过多");
    }

    @Override
    protected void handleOnDestroy() {
        for (Pending pending : active.values()) pending.stop();
        workers.shutdownNow(); timer.shutdownNow();
    }
}
