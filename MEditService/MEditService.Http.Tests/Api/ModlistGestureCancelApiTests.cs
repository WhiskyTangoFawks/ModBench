using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.Ports;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Http.Tests.Api;

public sealed class ModlistGestureCancelApiTests : HostedTests
{
    private const string Gesture = "a-gesture";

    private readonly ScratchDirectory _instance = new("modlist-gesture-cancel-");
    private readonly CancellingOnFirstMod _notifications = new();

    protected override MEditHost CreateHost() => new(services => services.AddSingleton<INotificationPublisher>(_notifications));

    protected override void DisposeFixtures() => _instance.Dispose();

    private string FolderOf(string mod) => Path.Combine(_instance, "mods", mod);

    private object Request(string gesture)
    {
        foreach (var mod in new[] { "ModA", "ModB" })
        {
            Directory.CreateDirectory(FolderOf(mod));
            File.WriteAllText(Path.Combine(FolderOf(mod), "a.txt"), mod);
        }
        object[] mods = [.. new[] { "ModA", "ModB" }.Select(mod => new { name = mod, folder = FolderOf(mod), metadataFiles = Array.Empty<string>() })];
        return new
        {
            mods,
            statCache = Path.Combine(_instance, "stat-cache"),
            exclusionMark = ".mohidden",
            gesture,
        };
    }

    private async Task<JsonElement> Post(string route, string gesture)
    {
        var response = await Client.PostAsJsonAsync(route, Request(gesture));
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private Task<HttpResponseMessage> Cancel(string gesture) => Client.PostAsync($"/modlist-gestures/{gesture}/cancel", null);

    private static string[] Answered(JsonElement body) =>
        [.. body.GetProperty("applied").EnumerateArray().Concat(body.GetProperty("refused").EnumerateArray())
            .Select(item => (item.TryGetProperty("mod", out var mod) ? mod : item.GetProperty("item")).GetString() ?? "")];

    [Fact]
    public async Task AGestureCancelledWhileItsFirstModIsInHand_AnswersThatModAlone()
    {
        HttpStatusCode? cancelled = null;
        _notifications.OnFirstMod = () => cancelled = Cancel(Gesture).GetAwaiter().GetResult().StatusCode;

        var body = await Post("/restore-from-manifest", Gesture);

        Assert.Equal(HttpStatusCode.NoContent, cancelled);
        Assert.Equal(["ModA"], Answered(body));
    }

    [Fact]
    public async Task ACancelForNoRunningGesture_Is404_EvenForOneThatHasEnded_WhoseIdANewGestureThenRunsUnder()
    {
        var never = await Cancel("never-ran");
        await Post("/restore-from-manifest", Gesture);

        var late = await Cancel(Gesture);
        var again = await Post("/restore-from-manifest", Gesture);

        Assert.Equal((HttpStatusCode.NotFound, HttpStatusCode.NotFound), (never.StatusCode, late.StatusCode));
        Assert.Equal(["ModA", "ModB"], Answered(again));
    }

    private sealed class CancellingOnFirstMod : INotificationPublisher
    {
        public Action? OnFirstMod { get; set; }

        public void Publish(INotification notification)
        {
            var progress = notification switch
            {
                RestoreFromManifestProgressNotification n => n.Progress,
                _ => null,
            };
            if (progress is not { Mod: not null, ModsDone: 0 }) return;
            OnFirstMod?.Invoke();
            OnFirstMod = null;
        }
    }
}
