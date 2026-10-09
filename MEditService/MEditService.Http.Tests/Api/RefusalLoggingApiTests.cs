using System.Net.Http.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class RefusalLoggingApiTests : HostedTests
{
    private const string Plugin = "Held.esp";
    private const string Origin = "HeldMod";

    private async Task LoadedAndTracked()
    {
        var fx = Owned(new PluginFixtureBuilder("api-refusal-logging")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("HeldNpc"), origin: Origin)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(Origin)).EnsureSuccessStatusCode();
    }

    private void AssertLoggedOnce(string start, string refusal)
    {
        var logged = Assert.Single(Logged, entry => entry.Message.StartsWith(start, StringComparison.Ordinal));
        Assert.Equal(LogLevel.Warning, logged.Level);
        Assert.Contains(refusal, logged.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ARefusedDeleteItem_IsLoggedOnce_NamingTheRecordAndWhy()
    {
        await LoadedAndTracked();

        await Client.PostAsJsonAsync("/records/delete-changes", new
        {
            records = new[] { new { formKey = "000FFF:Held.esp", plugin = Plugin, origin = Origin } },
        });

        AssertLoggedOnce("Refused Delete of", "RecordNotFound");
    }

    [Fact]
    public async Task ARefusedEdit_IsLoggedOnce_NamingWhy()
    {
        await LoadedAndTracked();

        await Client.Edit("000FFF:Held.esp", Plugin, Origin, "EditorID", "Renamed");

        AssertLoggedOnce("Refused Edit", "RecordNotFound");
    }

    [Fact]
    public async Task ARefusedCreateRecord_IsLoggedOnce_NamingWhy()
    {
        await LoadedAndTracked();

        await Client.PostAsJsonAsync(
            $"/plugins/{Plugin}/records", new { origin = Origin, recordType = "nosuch" });

        AssertLoggedOnce("Refused Create record", "RecordTypeNotFound");
    }
}
