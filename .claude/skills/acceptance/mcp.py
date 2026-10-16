"""One MCP request to a Modbench window's server: python3 -I mcp.py <port> tools | <port> call <tool> '<json>'."""
import json
import sys
import urllib.request


def post(url, body, session=None):
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if session:
        headers["Mcp-Session-Id"] = session
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(request, timeout=600) as response:
        session = response.headers.get("Mcp-Session-Id") or session
        text = response.read().decode()
    if text.startswith(("event:", "data:")) or "\ndata:" in text:
        text = "\n".join(line[5:].strip() for line in text.splitlines() if line.startswith("data:"))
    return (json.loads(text) if text.strip() else None), session


def request(port, method, params):
    url = f"http://127.0.0.1:{port}/mcp"
    _, session = post(url, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "acceptance", "version": "1"}}})
    post(url, {"jsonrpc": "2.0", "method": "notifications/initialized"}, session)
    reply, _ = post(url, {"jsonrpc": "2.0", "id": 2, "method": method, "params": params}, session)
    return reply


def main():
    port, verb = sys.argv[1], sys.argv[2]
    if verb == "tools":
        for tool in request(port, "tools/list", {})["result"]["tools"]:
            print(f"{tool['name']} {json.dumps(tool.get('inputSchema', {}).get('properties', {}))}\n  {tool['description']}")
        return
    result = request(port, "tools/call", {"name": sys.argv[3], "arguments": json.loads(sys.argv[4] if len(sys.argv) > 4 else "{}")})["result"]
    print("\n".join(part.get("text", "") for part in result["content"]))
    sys.exit(1 if result.get("isError") else 0)


if __name__ == "__main__":
    main()
