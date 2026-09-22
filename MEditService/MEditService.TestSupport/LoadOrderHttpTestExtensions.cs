using System.Diagnostics;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

namespace MEditService.TestSupport;

/// <summary>PUT /load-order answers with the version it applied. A test waits for status to
/// reach that version, never for a tick or the sequence, either missable before the wait even
/// starts.</summary>
public static class LoadOrderHttpTestExtensions
{
    /// <summary>PUTs, then awaits the same terminal-by-version state a real client waits for
    /// before returning. The response is the PUT's own — still checkable for its status and body.</summary>
    public static async Task<HttpResponseMessage> PutLoadOrderAndAwaitReady(
        this HttpClient client, object body, TimeSpan? timeout = null)
    {
        var response = await client.PutAsJsonAsync("/load-order", body);
        if (response.IsSuccessStatusCode)
        {
            // Read as text and replace the content with it: the caller still reads this same
            // body for its own assertions, and the connection's own stream only ever answers once.
            var text = await response.Content.ReadAsStringAsync();
            response.Content = new StringContent(text, Encoding.UTF8, "application/json");
            var applied = JsonSerializer.Deserialize<JsonElement>(text);
            await client.AwaitTerminalLoadOrderStatus(applied.GetProperty("version").GetInt64(), timeout);
        }
        return response;
    }

    /// <summary>Polls status until it answers for at least <paramref name="appliedVersion"/> and
    /// is terminal (Ready, HeldElsewhere or Failed) — status is published anew for every arrival,
    /// even a no-op resend.</summary>
    public static async Task AwaitTerminalLoadOrderStatus(
        this HttpClient client, long appliedVersion, TimeSpan? timeout = null)
    {
        var limit = timeout ?? TimeSpan.FromSeconds(60);
        var elapsed = Stopwatch.StartNew();
        while (elapsed.Elapsed < limit)
        {
            var status = await client.GetFromJsonAsync<JsonElement>("/load-order/status");
            var version = status.GetProperty("version").GetInt64();
            var state = status.GetProperty("state").GetString();

            if (version >= appliedVersion && state is "Ready" or "HeldElsewhere" or "Failed") return;

            await Task.Delay(20);
        }
        throw new TimeoutException(
            $"The load order never reached a terminal state for version {appliedVersion}.");
    }
}
