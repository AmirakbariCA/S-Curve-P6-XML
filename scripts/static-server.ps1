$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..\dist')
$port = 4173
$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.js' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.png' = 'image/png'
  '.svg' = 'image/svg+xml'
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse('127.0.0.1'), $port)
$listener.Start()

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $stream = $client.GetStream()
    $buffer = New-Object byte[] 8192
    $read = $stream.Read($buffer, 0, $buffer.Length)
    $request = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
    $firstLine = ($request -split "`r?`n")[0]
    $parts = $firstLine -split ' '
    $path = if ($parts.Length -ge 2) { [System.Uri]::UnescapeDataString($parts[1].Split('?')[0].TrimStart('/')) } else { 'index.html' }
    if ([string]::IsNullOrWhiteSpace($path)) { $path = 'index.html' }
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $root $path))
    if (-not $candidate.StartsWith($root.Path) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      $candidate = Join-Path $root 'index.html'
    }

    $extension = [System.IO.Path]::GetExtension($candidate)
    $contentType = if ($types.ContainsKey($extension)) { $types[$extension] } else { 'application/octet-stream' }
    $body = [System.IO.File]::ReadAllBytes($candidate)
    $headers = "HTTP/1.1 200 OK`r`nContent-Type: $contentType`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers)
    $stream.Write($headerBytes, 0, $headerBytes.Length)
    $stream.Write($body, 0, $body.Length)
  } catch {
    try {
      $body = [System.Text.Encoding]::UTF8.GetBytes('Not found')
      $headers = "HTTP/1.1 404 Not Found`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
      $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers)
      $stream.Write($headerBytes, 0, $headerBytes.Length)
      $stream.Write($body, 0, $body.Length)
    } catch {}
  } finally {
    $client.Close()
  }
}
