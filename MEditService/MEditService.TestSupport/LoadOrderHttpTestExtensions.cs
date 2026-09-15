using System.Net.Http.Json;
using System.Text.Json;

namespace MEditService.Tests.TestSupport;

/// <summary>PUT /load-order answers applied at once; the sweep runs on Load order state's own
/// Changed subscriber. A test needing the sweep done waits for it by polling, never by trusting
/// the PUT's own timing.</summary>
public static class LoadOrderHttpTestExtensions
{
    // A resend that changes nothing advances neither: held this long with no further movement, it
    // is a genuine no-op rather than a reconcile that has simply not started yet.
    private static readonly TimeSpan NoOpGrace = TimeSpan.FromMilliseconds(150);

    /// <summary>PUTs, then awaits the same terminal state a real client polls for before returning.
    /// The response is the PUT's own — still checkable for its status code and body.</summary>
    public static async Task<HttpResponseMessage> PutLoadOrderAndAwaitReady(
        this HttpClient client, object body, TimeSpan? timeout = null)
    {
        var beforeSequence = await client.GetFromJsonAsync<long>("/load-order/sequence");
        var response = await client.PutAsJsonAsync("/load-order", body);
        if (response.IsSuccessStatusCode) await client.AwaitTerminalLoadOrderStatus(beforeSequence, timeout);
        return response;
    }

    /// <summary>Polls the sequence past what held before this PUT, and Ready itself. None never
    /// counts as done; only a Ready resend that moved nothing settles on its own grace.</summary>
    public static async Task AwaitTerminalLoadOrderStatus(
        this HttpClient client, long beforeSequence, TimeSpan? timeout = null)
    {
        var deadline = DateTime.UtcNow + (timeout ?? TimeSpan.FromSeconds(60));
        DateTime? unchangedSince = null;
        while (DateTime.UtcNow < deadline)
        {
            var sequence = await client.GetFromJsonAsync<long>("/load-order/sequence");
            var status = await client.GetFromJsonAsync<JsonElement>("/load-order/status");
            var state = status.GetProperty("state").GetString();

            if (state is "HeldElsewhere" or "Failed") return;
            if (state == "Ready" && sequence > beforeSequence) return;

            if (state == "Ready" && sequence == beforeSequence)
            {
                unchangedSince ??= DateTime.UtcNow;
                if (DateTime.UtcNow - unchangedSince > NoOpGrace) return;
            }
            else
            {
                unchangedSince = null;
            }

            await Task.Delay(20);
        }
        throw new TimeoutException("The load order never reached a terminal state (Ready/HeldElsewhere/Failed).");
    }
}
