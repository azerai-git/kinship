param([string]$Root, [int]$Port = 8765)
Add-Type -AssemblyName System.Net.Http
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
$http = [System.Net.Http.HttpClient]::new()
Write-Host "Serving $Root on http://localhost:$Port/ (with /proxy for Mozilla hosts)"
$types = @{ ".html"="text/html; charset=utf-8"; ".js"="text/javascript; charset=utf-8"; ".css"="text/css"; ".json"="application/json" }

function Send-Proxy($ctx) {
  $target = $ctx.Request.QueryString["url"]
  $u = [Uri]$target
  if (-not ($u.Scheme -eq "https" -and ($u.Host -eq "accounts.firefox.com" -or $u.Host.EndsWith(".accounts.firefox.com") -or $u.Host.EndsWith(".services.mozilla.com")))) {
    $ctx.Response.StatusCode = 403; return
  }
  $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($ctx.Request.HttpMethod), $u)
  foreach ($h in @("Authorization", "X-KeyID", "Accept", "TTL", "X-If-Unmodified-Since", "X-If-Modified-Since")) {
    $v = $ctx.Request.Headers[$h]
    if ($v) { [void]$req.Headers.TryAddWithoutValidation($h, $v) }
  }
  if ($ctx.Request.HasEntityBody) {
    $ms = [System.IO.MemoryStream]::new(); $ctx.Request.InputStream.CopyTo($ms)
    $req.Content = [System.Net.Http.ByteArrayContent]::new($ms.ToArray())
    $ct = $ctx.Request.ContentType
    if ($ct) { [void]$req.Content.Headers.TryAddWithoutValidation("Content-Type", $ct) }
    # Web Push: the browser can't set Content-Encoding on fetch, so tests send it as X-Content-Encoding
    $ce = $ctx.Request.Headers["X-Content-Encoding"]
    if ($ce) { [void]$req.Content.Headers.TryAddWithoutValidation("Content-Encoding", $ce) }
  }
  $resp = $http.SendAsync($req).GetAwaiter().GetResult()
  $bytes = $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
  $ctx.Response.StatusCode = [int]$resp.StatusCode
  $ctx.Response.ContentType = "application/json"
  foreach ($h in @("X-Weave-Next-Offset", "X-Weave-Timestamp", "Retry-After")) {
    $vals = $null
    if ($resp.Headers.TryGetValues($h, [ref]$vals)) { $ctx.Response.Headers.Add($h, ($vals -join ",")) }
  }
  $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $line = "PROXY $($ctx.Request.HttpMethod) $($u.Host)$($u.AbsolutePath) -> $([int]$resp.StatusCode)"
  if ([int]$resp.StatusCode -ge 400) {
    # error bodies only (they hold errno/message, not user data); truncated
    $txt = [System.Text.Encoding]::UTF8.GetString($bytes)
    $line += " " + $txt.Substring(0, [Math]::Min(200, $txt.Length))
  }
  Write-Host $line
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ($path -eq "proxy") { Send-Proxy $ctx }
    else {
      $full = [System.IO.Path]::GetFullPath((Join-Path $Root $path))
      if ($full.StartsWith([System.IO.Path]::GetFullPath($Root)) -and (Test-Path $full -PathType Leaf)) {
        $bytes = [System.IO.File]::ReadAllBytes($full)
        $ext = [System.IO.Path]::GetExtension($full)
        $ctx.Response.ContentType = if ($types[$ext]) { $types[$ext] } else { "application/octet-stream" }
        $ctx.Response.Headers.Add("Cache-Control", "no-store")
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      } else { $ctx.Response.StatusCode = 404 }
    }
  } catch {
    Write-Host "ERROR $_"
    try { $ctx.Response.StatusCode = 502 } catch {}
  }
  $ctx.Response.Close()
}
