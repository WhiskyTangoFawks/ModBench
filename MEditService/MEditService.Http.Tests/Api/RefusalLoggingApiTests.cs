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

    private async Task LoadedAndCompiledPlugin()
    {
        var fx = Owned(new PluginFixtureBuilder("api-refusal-logging")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("HeldNpc"), origin: Origin)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.DecompileAndCommit(Origin)).EnsureSuccessStatusCode();
    }

    private void AssertLoggedOnce(string start, string refusal)
    {
        var logged = Assert.Single(Logged, entry => entry.Message.StartsWith(start, StringComparison.Ordinal));
        Assert.Equal(LogLevel.Warning, logged.Level);
        Assert.Contains(refusal, logged.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AReadTheIndexRefuses_IsLoggedOnce_NamingTheRouteAndWhy()
    {
        await Client.GetAsync(new Uri("/plugins", UriKind.Relative));

        AssertLoggedOnce("GET /plugins refused", "NoLoadOrder");
    }

    [Fact]
    public async Task ARefusedPutLoadOrder_IsLoggedOnce_NamingWhy()
    {
        using var scratch = new ScratchDirectory("refusal-logging-");
        var gone = Path.Combine(scratch, "no-such-data-folder");

        await Client.PutAsJsonAsync("/load-order", SnapshotPlugins.Body(gone, gone, []));

        AssertLoggedOnce("Refused Put load order", "DataFolderNotFound");
    }

    [Fact]
    public async Task ARefusedDeleteItem_IsLoggedOnce_NamingTheRecordAndWhy()
    {
        await LoadedAndCompiledPlugin();

        await Client.PostAsJsonAsync("/records/delete-changes", new
        {
            records = new[] { new { formKey = "000FFF:Held.esp", plugin = new { name = Plugin, origin = Origin } } }
        });

        AssertLoggedOnce("Refused Delete of", "RecordNotFound");
    }

    [Fact]
    public async Task ARefusedDecompileItem_IsLoggedOnce_NamingThePluginAndWhy()
    {
        await LoadedAndCompiledPlugin();

        await Client.Decompile([("NotLoaded.esp", Origin)]);

        AssertLoggedOnce("Refused Decompile of PluginAddress { Name = NotLoaded.esp, Origin = HeldMod }:", "PluginNotLoaded");
    }

    [Fact]
    public async Task ARefusedEdit_IsLoggedOnce_NamingWhy()
    {
        await LoadedAndCompiledPlugin();

        await Client.Edit("000FFF:Held.esp", Plugin, Origin, "EditorID", "Renamed");

        AssertLoggedOnce("Refused Edit", "RecordNotFound");
    }

    [Fact]
    public async Task ARefusedScriptEdit_IsLoggedOnce_NamingWhy()
    {
        await LoadedAndCompiledPlugin();

        await Client.ScriptEdit("000FFF:Held.esp", Plugin, Origin, "EditorID", "Renamed");

        AssertLoggedOnce("Refused EditRecord", "RecordNotFound");
    }

    [Fact]
    public async Task ARefusedCreateRecord_IsLoggedOnce_NamingWhy()
    {
        await LoadedAndCompiledPlugin();

        await Client.CreateRecord(Plugin, Origin, "nosuch");

        AssertLoggedOnce("Refused Create record", "RecordTypeNotFound");
    }

    [Fact]
    public async Task AnUpdateManifestItemRefused_IsLoggedOnce_NamingTheModAndWhy()
    {
        using var instance = new ScratchDirectory("refusal-logging-update-manifest-");

        await Client.PostAsJsonAsync("/update-manifest", new
        {
            mods = new[] { new { name = "Gone", folder = Path.Combine(instance, "Gone"), metadataFiles = Array.Empty<string>() } },
            statCache = Path.Combine(instance, "stat-cache"),
        });

        AssertLoggedOnce("Refused Update manifest of Gone:", "ModFolderMissing");
    }

    [Fact]
    public async Task ARestoreFromManifestItemSkipped_IsLoggedOnce_NamingTheModAndWhy()
    {
        using var instance = new ScratchDirectory("refusal-logging-restore-");
        var folder = Directory.CreateDirectory(Path.Combine(instance, "Bare")).FullName;

        await Client.PostAsJsonAsync("/restore-from-manifest", new
        {
            mods = new[] { new { name = "Bare", folder, metadataFiles = Array.Empty<string>() } },
            statCache = Path.Combine(instance, "stat-cache"),
            exclusionMark = ".mohidden",
        });

        AssertLoggedOnce("Refused Restore from manifest of Bare:", "NoManifest");
    }

    [Fact]
    public async Task ARefusedCreatePlugin_IsLoggedOnce_NamingThePluginAndWhy()
    {
        using var scratch = new ScratchDirectory("refusal-logging-create-");
        await LoadedAndCompiledPlugin();
        OtherTool.WritesTheFile(Path.Combine(scratch, "Taken.esp"), "another tool's file");

        await Client.PostAsJsonAsync("/plugins/create", new { origin = "TakenMod", name = "Taken.esp", folder = scratch.Path });

        AssertLoggedOnce("Refused Create plugin of PluginAddress { Name = Taken.esp, Origin = TakenMod }:", "FileExists");
    }
}
