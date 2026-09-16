using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Http.Endpoints;
using MEditService.LoadOrder;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

/// <summary>Status code and body shape for the write handlers' error-mapping paths the endpoint
/// suites do not reach, including the IO/UnauthorizedAccess to 500 mapping.</summary>
[Collection(WebHostCollection.Name)]
public sealed class WriteEndpointMappingCharacterizationTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    private const string Origin = "EditableMod";
    private const string Plugin = "Editable.esp";
    private const string DestOrigin = "DestinationMod";
    private const string DestPlugin = "Destination.esp";

    private static ScatteredFixtureData BuildOneModOnePlugin() =>
        new PluginFixtureBuilder("api-604-one")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("ApiNpc"), origin: Origin)
            .BuildScattered();

    private static ScatteredFixtureData BuildSourceAndDestination() =>
        new PluginFixtureBuilder("api-604-two")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("ApiNpc"), origin: Origin)
            .WithPlugin(DestPlugin, mod => mod.Npcs.AddNew("DestNpc"), origin: DestOrigin)
            .BuildScattered();

    private async Task Load(ScatteredFixtureData fx)
    {
        var load = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = fx.Plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();
    }

    private async Task Track(string origin) =>
        (await _client.PostAsJsonAsync("/plugins/track", new { origin, preset = "Edits" })).EnsureSuccessStatusCode();

    private async Task<string> FirstNpcFormKey(string plugin)
    {
        var records = await _client.GetFromJsonAsync<JsonElement>($"/records?plugin={plugin}&type=npc_");
        return DocumentNodes.StringValueOf(records.GetProperty("items")[0].GetProperty("formKey"));
    }

    private static string ModFolderOf(ScatteredFixtureData fx, string origin) =>
        PathShape.DirectoryOf(fx.Plugins.Single(p => p.Origin == origin).Path);

    // Process-shelled because File.SetUnixFileMode is flagged platform-unsafe (CA1416) even on a
    // Linux-only runtime. Recursive: handlers write into subdirectories Track left writable, so a
    // chmod on the root alone would not block the write.
    private static void Chmod(string path, string mode)
    {
        using var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(
            "chmod", ["-R", mode, path])
        { RedirectStandardError = true })
            ?? throw new InvalidOperationException($"Expected 'chmod {mode} {path}' to start a process.");
        process.WaitForExit();
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"chmod {mode} {path} failed: {process.StandardError.ReadToEnd()}");
    }

    // --- DeleteRecord ---

    [Fact]
    public async Task DeleteRecord_OnATrackedPlugin_Succeeds()
    {
        using var fx = BuildOneModOnePlugin();
        await Load(fx);
        await Track(Origin);
        var formKey = await FirstNpcFormKey(Plugin);

        var response = await _client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/delete", new { plugin = Plugin, origin = Origin });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.GetProperty("applied").GetBoolean());
        Assert.Equal(formKey, body.GetProperty("formKey").GetString());
    }

    [Fact]
    public async Task DeleteRecord_OnAnUntrackedPlugin_IsRefusedWithATypedRefusal()
    {
        using var fx = BuildOneModOnePlugin();
        await Load(fx); // deliberately not tracked
        var formKey = await FirstNpcFormKey(Plugin);

        var response = await _client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/delete", new { plugin = Plugin, origin = Origin });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("PluginNotTracked", problem.GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task DeleteRecord_WhenTheSourceFileCannotBeDeleted_IsAShapedProblem_NotAnUnhandled500()
    {
        using var fx = BuildOneModOnePlugin();
        await Load(fx);
        await Track(Origin);
        var formKey = await FirstNpcFormKey(Plugin);
        var modFolder = ModFolderOf(fx, Origin);

        Chmod(modFolder, "500"); // read+execute only
        try
        {
            var response = await _client.PostAsJsonAsync(
                $"/records/{Uri.EscapeDataString(formKey)}/delete", new { plugin = Plugin, origin = Origin });

            Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
            var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.False(string.IsNullOrWhiteSpace(problem.GetProperty("detail").GetString()));
        }
        finally
        {
            Chmod(modFolder, "700"); // restored before fx.Dispose() needs to clean up
        }
    }

    // --- RenumberRecord (400/200 already pinned by MalformedFormKeyEndpointTests/RenumberApiTests) ---

    [Fact]
    public async Task RenumberRecord_OnAnUntrackedPlugin_IsRefusedWithATypedRefusal()
    {
        using var fx = BuildOneModOnePlugin();
        await Load(fx); // deliberately not tracked
        var formKey = await FirstNpcFormKey(Plugin);

        var response = await _client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/renumber",
            new { plugin = Plugin, origin = Origin, newFormKey = (string?)null });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("PluginNotTracked", problem.GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task RenumberRecord_WhenTheSourceCannotBeWritten_IsAShapedProblem_NotAnUnhandled500()
    {
        using var fx = BuildOneModOnePlugin();
        await Load(fx);
        await Track(Origin);
        var formKey = await FirstNpcFormKey(Plugin);
        var modFolder = ModFolderOf(fx, Origin);

        Chmod(modFolder, "500"); // read+execute only
        try
        {
            var response = await _client.PostAsJsonAsync(
                $"/records/{Uri.EscapeDataString(formKey)}/renumber",
                new { plugin = Plugin, origin = Origin, newFormKey = (string?)null });

            Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
            var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.False(string.IsNullOrWhiteSpace(problem.GetProperty("detail").GetString()));
        }
        finally
        {
            Chmod(modFolder, "700"); // restored before fx.Dispose() needs to clean up
        }
    }

    // --- CopyRecordAsOverride ---

    [Fact]
    public async Task CopyRecordAsOverride_IntoATrackedDestination_Succeeds()
    {
        using var fx = BuildSourceAndDestination();
        await Load(fx);
        await Track(DestOrigin); // source deliberately left untracked — CopyFixture's own default shape
        var formKey = await FirstNpcFormKey(Plugin);

        var response = await _client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/copy-as-override",
            new { sourcePlugin = Plugin, sourceOrigin = Origin, destinationPlugin = DestPlugin, destinationOrigin = DestOrigin });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.GetProperty("applied").GetBoolean());
        Assert.Equal(formKey, body.GetProperty("formKey").GetString());
    }

    [Fact]
    public async Task CopyRecordAsOverride_IntoAnUntrackedDestination_IsRefusedWithATypedRefusal()
    {
        using var fx = BuildSourceAndDestination();
        await Load(fx); // destination deliberately left untracked
        var formKey = await FirstNpcFormKey(Plugin);

        var response = await _client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/copy-as-override",
            new { sourcePlugin = Plugin, sourceOrigin = Origin, destinationPlugin = DestPlugin, destinationOrigin = DestOrigin });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("PluginNotTracked", problem.GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task CopyRecordAsOverride_WhenTheDestinationCannotBeWritten_IsAShapedProblem_NotAnUnhandled500()
    {
        using var fx = BuildSourceAndDestination();
        await Load(fx);
        await Track(DestOrigin);
        var formKey = await FirstNpcFormKey(Plugin);
        var destModFolder = ModFolderOf(fx, DestOrigin);

        Chmod(destModFolder, "500"); // read+execute only
        try
        {
            var response = await _client.PostAsJsonAsync(
                $"/records/{Uri.EscapeDataString(formKey)}/copy-as-override",
                new { sourcePlugin = Plugin, sourceOrigin = Origin, destinationPlugin = DestPlugin, destinationOrigin = DestOrigin });

            Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
            var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.False(string.IsNullOrWhiteSpace(problem.GetProperty("detail").GetString()));
        }
        finally
        {
            Chmod(destModFolder, "700"); // restored before fx.Dispose() needs to clean up
        }
    }

    // --- CopyRecordAsNewRecord (400 already pinned by MalformedFormKeyEndpointTests) ---

    [Fact]
    public async Task CopyRecordAsNewRecord_IntoATrackedDestination_Succeeds()
    {
        using var fx = BuildSourceAndDestination();
        await Load(fx);
        await Track(DestOrigin);
        var formKey = await FirstNpcFormKey(Plugin);

        var response = await _client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/copy-as-new-record",
            new
            {
                sourcePlugin = Plugin,
                sourceOrigin = Origin,
                destinationPlugin = DestPlugin,
                destinationOrigin = DestOrigin,
                requestedFormKey = (string?)null,
            });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.GetProperty("applied").GetBoolean());
        Assert.Equal(formKey, body.GetProperty("sourceFormKey").GetString());
        Assert.False(string.IsNullOrWhiteSpace(body.GetProperty("newFormKey").GetString()));
    }

    [Fact]
    public async Task CopyRecordAsNewRecord_IntoAnUntrackedDestination_IsRefusedWithATypedRefusal()
    {
        using var fx = BuildSourceAndDestination();
        await Load(fx); // destination deliberately left untracked
        var formKey = await FirstNpcFormKey(Plugin);

        var response = await _client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/copy-as-new-record",
            new
            {
                sourcePlugin = Plugin,
                sourceOrigin = Origin,
                destinationPlugin = DestPlugin,
                destinationOrigin = DestOrigin,
                requestedFormKey = (string?)null,
            });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("PluginNotTracked", problem.GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task CopyRecordAsNewRecord_WhenTheDestinationCannotBeWritten_IsAShapedProblem_NotAnUnhandled500()
    {
        using var fx = BuildSourceAndDestination();
        await Load(fx);
        await Track(DestOrigin);
        var formKey = await FirstNpcFormKey(Plugin);
        var destModFolder = ModFolderOf(fx, DestOrigin);

        Chmod(destModFolder, "500"); // read+execute only
        try
        {
            var response = await _client.PostAsJsonAsync(
                $"/records/{Uri.EscapeDataString(formKey)}/copy-as-new-record",
                new
                {
                    sourcePlugin = Plugin,
                    sourceOrigin = Origin,
                    destinationPlugin = DestPlugin,
                    destinationOrigin = DestOrigin,
                    requestedFormKey = (string?)null,
                });

            Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
            var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.False(string.IsNullOrWhiteSpace(problem.GetProperty("detail").GetString()));
        }
        finally
        {
            Chmod(destModFolder, "700"); // restored before fx.Dispose() needs to clean up
        }
    }

    // --- CreateRecord (400 already pinned by MalformedFormKeyEndpointTests; 200 incidentally by RenumberApiTests) ---

    [Fact]
    public async Task CreateRecord_OnAnUntrackedPlugin_IsRefusedWithATypedRefusal()
    {
        using var fx = BuildOneModOnePlugin();
        await Load(fx); // deliberately not tracked

        var response = await _client.PostAsJsonAsync($"/plugins/{Plugin}/records", new
        {
            origin = Origin,
            recordType = "npc_",
            editorId = "Untracked",
            formKey = (string?)null,
        });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("PluginNotTracked", problem.GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task CreateRecord_WhenTheSourceFileCannotBeWritten_IsAShapedProblem_NotAnUnhandled500()
    {
        using var fx = BuildOneModOnePlugin();
        await Load(fx);
        await Track(Origin);
        var modFolder = ModFolderOf(fx, Origin);

        Chmod(modFolder, "500"); // read+execute only
        try
        {
            var response = await _client.PostAsJsonAsync($"/plugins/{Plugin}/records", new
            {
                origin = Origin,
                recordType = "npc_",
                editorId = "BrandNew",
                formKey = (string?)null,
            });

            Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
            var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.False(string.IsNullOrWhiteSpace(problem.GetProperty("detail").GetString()));
        }
        finally
        {
            Chmod(modFolder, "700"); // restored before fx.Dispose() needs to clean up
        }
    }

    // --- PeekNextFreeFormKey ---

    [Fact]
    public async Task PeekNextFreeFormKey_OnATrackedPlugin_Succeeds()
    {
        using var fx = BuildOneModOnePlugin();
        await Load(fx);
        await Track(Origin);

        var response = await _client.GetAsync($"/plugins/{Plugin}/records/next-form-key?origin={Origin}");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(string.IsNullOrWhiteSpace(body.GetProperty("formKey").GetString()));
    }

    // --- Compile ---

    [Fact]
    public async Task Compile_OnATrackedPlugin_Succeeds()
    {
        using var fx = BuildOneModOnePlugin();
        await Load(fx);
        await Track(Origin);

        var response = await _client.PostAsJsonAsync($"/plugins/{Plugin}/compile", new { origin = Origin, @ref = (string?)null });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.GetProperty("succeeded").GetBoolean());
    }

    [Fact]
    public async Task Compile_WhenTheBinaryCannotBeWritten_IsAShapedProblem_NotAnUnhandled500()
    {
        using var fx = BuildOneModOnePlugin();
        await Load(fx);
        await Track(Origin);
        var modFolder = ModFolderOf(fx, Origin);

        Chmod(modFolder, "500"); // read+execute only
        try
        {
            var response = await _client.PostAsJsonAsync($"/plugins/{Plugin}/compile", new { origin = Origin, @ref = (string?)null });

            Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
            var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.False(string.IsNullOrWhiteSpace(problem.GetProperty("detail").GetString()));
        }
        finally
        {
            Chmod(modFolder, "700"); // restored before fx.Dispose() needs to clean up
        }
    }
}

/// <summary>Sabotages the plugin binary rather than the mod folder's write permission: both handlers
/// deep-parse it before anything reaches git, and a git failure would surface as
/// GitUnavailableException, which the 500 mapper must not catch.</summary>
public sealed class ExternalChangeEndpointMappingCharacterizationTests : IDisposable
{
    private readonly IndexedModFixture _mod = IndexedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private static (ILoggerFactory factory, List<LogEntry> entries) CapturingLoggerFactory()
    {
        var entries = new List<LogEntry>();
        var factory = LoggerFactory.Create(b =>
        {
            b.SetMinimumLevel(LogLevel.Information);
            b.AddProvider(new CollectingLoggerProvider(entries));
        });
        return (factory, entries);
    }

    private string PluginPath => Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName);

    // Process-shelled — same reasoning as WriteEndpointMappingCharacterizationTests.Chmod.
    private static void Chmod(string path, string mode)
    {
        using var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(
            "chmod", ["-R", mode, path])
        { RedirectStandardError = true })
            ?? throw new InvalidOperationException($"Expected 'chmod {mode} {path}' to start a process.");
        process.WaitForExit();
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"chmod {mode} {path} failed: {process.StandardError.ReadToEnd()}");
    }

    // AbsorbExternalChange's IOException catch is uncovered because the race is impractical to
    // reproduce in-process, not because it is unreachable: Absorb re-reads the plugin for its SHA256
    // after the deep-parse, a real TOCTOU window.

    // Sabotages the record write rather than the binary, so the Mutagen deep-parse still succeeds:
    // Keep's raw File.WriteAllText is MEditService's own I/O and not Mutagen-wrapped.
    private void WriteExternalBinaryChange(float newHeightMax)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(IndexedModFixture.PluginName), Fallout4Release.Fallout4);
        var race = mod.Races.AddNew("FixtureRace");
        mod.Keywords.AddNew("FixtureKeyword");
        var npc = mod.Npcs.AddNew("FixtureNpc");
        npc.Race.SetTo(race);
        npc.HeightMax = newHeightMax;
        mod.Npcs.AddNew("UntouchedNpc");
        mod.WriteToBinary(PluginPath);
    }

    [Fact]
    public void KeepExternalChange_WhenTheTouchedRecordCannotBeWritten_IsAShapedProblem_NotAnUnhandled500()
    {
        WriteExternalBinaryChange(0.9f); // no pre-existing local edit on FixtureNpc — not a collision
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        Chmod(_mod.ModFolder, "500"); // read+execute only — the touched record's rewrite can't land
        try
        {
            var result = PluginEndpoints.KeepExternalChange(new ExternalChangeActionRequest(IndexedModFixture.ModFolderOrigin),
                _mod.Holder, TestEditService.KeepHandler(), TestWatcher.Inert(), loggerFactory);

            var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
            Assert.Equal(500, problem.StatusCode);
            Assert.False(string.IsNullOrWhiteSpace(problem.ProblemDetails.Detail));
        }
        finally
        {
            Chmod(_mod.ModFolder, "700"); // restored before IndexedModFixture.Dispose() needs to clean up
        }
    }

    [Fact]
    public void KeepExternalChange_UnknownOrigin_Returns503()
    {
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.KeepExternalChange(new ExternalChangeActionRequest("NoSuchOrigin"),
            _mod.Holder, TestEditService.KeepHandler(), TestWatcher.Inert(), loggerFactory);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(503, problem.StatusCode);
    }
}
