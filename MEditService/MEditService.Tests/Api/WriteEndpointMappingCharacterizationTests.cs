using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Api.Endpoints;
using MEditService.Bridge;
using MEditService.Core.Plugins;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

/// <summary>
/// #604: characterization tests for the write handlers' error-mapping shapes, written *before* the
/// refactor that centralizes them (a shared <c>PluginKeyOf</c> binder, the refusal/exception→
/// ProblemDetails mappers, <c>ResolveAnyPhysicalCopy</c>) — pinning today's status code and body
/// shape for exactly the paths <see cref="EditFieldApiTests"/>, <see cref="RenumberApiTests"/>,
/// <see cref="MalformedFormKeyEndpointTests"/> and <see cref="ExternalChangeEndpointsTests"/> do not
/// reach. Before this file: <c>DeleteRecord</c> and <c>CopyRecordAsOverride</c> had zero
/// endpoint-layer coverage of any kind; <c>PeekNextFreeFormKey</c> and <c>Compile</c> likewise; and
/// the <see cref="IOException"/>/<see cref="UnauthorizedAccessException"/> → 500 mapping this ticket
/// centralizes — the one thing it most wants centralized — was pinned for exactly one of the nine
/// sites that carry it (<c>EditField</c>, in <see cref="EditFieldApiTests"/>).
///
/// <para>Every test here must still pass, unmodified, after the refactor — that is the whole of "no
/// behavior moved" for the paths #604's other tests don't already prove. The rival: flip one
/// handler's 500 to a 502, or drop a <c>detail</c> string, and the corresponding test must go red
/// with an observed failure — confirmed by hand against a scratch copy of this file, never against
/// <c>git checkout</c>, before the refactor commit.</para>
/// </summary>
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
        var load = await _client.PutAsJsonAsync("/load-order", new
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
        return records.GetProperty("items")[0].GetProperty("formKey").GetString()!;
    }

    private static string ModFolderOf(ScatteredFixtureData fx, string origin) =>
        Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == origin).Path)!;

    // Process-shelled rather than File.Set/GetUnixFileMode — same reasoning as
    // PluginCompileServiceJournalTests.Chmod/RecordEditServiceRenumberRecordTests.Chmod (this
    // project's runtime is Linux-only per root CLAUDE.md, but that .NET API is flagged
    // platform-unsafe (CA1416) regardless, and suppressing an analyzer warning is not this test's
    // call to make on its own). Recursive, matching RecordEditServiceRenumberRecordTests' own
    // reasoning: several of these handlers create a brand-new source file in a subdirectory Track
    // already created and left writable, several directories under the mod folder's own root, so a
    // non-recursive chmod on the root alone would not block the write.
    private static void Chmod(string path, string mode)
    {
        using var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(
            "chmod", ["-R", mode, path])
        { RedirectStandardError = true })!;
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

    // --- CopyRecordAsOverride (zero prior endpoint-layer coverage) ---

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

    // --- PeekNextFreeFormKey (zero prior coverage) ---

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

    // --- Compile (zero prior coverage) ---

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

/// <summary>
/// #604: the same characterization purpose as <see cref="WriteEndpointMappingCharacterizationTests"/>,
/// for <c>AbsorbExternalChange</c>/<c>KeepExternalChange</c>'s own 500 path — untested by
/// <see cref="ExternalChangeEndpointsTests"/>, whose own tests exercise the 503/200 paths only.
/// Direct handler calls, matching that file's own established pattern (both are named static methods,
/// unlike <c>PeekNextFreeFormKey</c>, which is still an inline lambda and is characterized at the
/// wire instead). Sabotages the plugin *binary* rather than the mod folder's write permission: both
/// handlers open it for a fresh deep-parse before anything reaches git, and git failures surface as
/// <see cref="GitUnavailableException"/> — a type this ticket's 500 mapper does not and must not
/// catch — so a mod-folder-wide write block risks tripping the wrong exception type instead of the
/// one under test.
/// </summary>
public sealed class ExternalChangeEndpointMappingCharacterizationTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

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

    private string PluginPath => Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);

    // Process-shelled — same reasoning as WriteEndpointMappingCharacterizationTests.Chmod.
    private static void Chmod(string path, string mode)
    {
        using var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(
            "chmod", ["-R", mode, path])
        { RedirectStandardError = true })!;
        process.WaitForExit();
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"chmod {mode} {path} failed: {process.StandardError.ReadToEnd()}");
    }

    // #604 finding, reported rather than fixed here (out of this ticket's scope — the coordinator
    // owns the disposition): AbsorbExternalChange's declared `catch (Exception ex) when (ex is
    // IOException or UnauthorizedAccessException)` cannot actually be reached by sabotaging the
    // binary the way EditFieldApiTests does — Mutagen wraps a raw UnauthorizedAccessException from
    // an unreadable/corrupt binary into its own RecordException before this handler ever sees it
    // (confirmed empirically: ModFactory.Import's caller, Fallout4Mod.CreateFromBinary, does the
    // wrapping), and Absorb's own write path (TrackService.SerializeToPristineFiles → a fresh scratch
    // temp dir; SourceRepository.CommitPristineToMain → git subprocess calls, which fail as
    // GitUnavailableException, not IOException) never touches modFolder with raw file I/O either. No
    // characterization test for this path exists here for that reason — sabotaging modFolder produces
    // an exception type the endpoint's own catch clause does not declare, so it would document a
    // 500-turns-into-an-unhandled-exception gap, not the graceful mapping under refactor.

    // Leaves the plugin binary untouched (so the Mutagen deep-parse both Keep and the binary-wrap
    // problem above depend on still succeeds) and instead sabotages the *record* write —
    // ExternalChangeEditLander.Keep's own raw File.WriteAllText onto the touched record's flat source
    // path, unlike Absorb's wholesale re-serialize, is MEditService's own I/O and not Mutagen-wrapped.
    private void WriteExternalBinaryChange(float newHeightMax)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(TrackedModFixture.PluginName), Fallout4Release.Fallout4);
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
            var result = PluginEndpoints.KeepExternalChange(
                TrackedModFixture.PluginName, new ExternalChangeActionRequest(TrackedModFixture.ModFolderOrigin),
                _mod.Mirror, new ExternalChangeWatcher(), SharedSchemaReflector.Instance, loggerFactory);

            var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
            Assert.Equal(500, problem.StatusCode);
            Assert.False(string.IsNullOrWhiteSpace(problem.ProblemDetails.Detail));
        }
        finally
        {
            Chmod(_mod.ModFolder, "700"); // restored before TrackedModFixture.Dispose() needs to clean up
        }
    }

    [Fact]
    public void KeepExternalChange_UnknownOrigin_Returns503()
    {
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.KeepExternalChange(
            TrackedModFixture.PluginName, new ExternalChangeActionRequest("NoSuchOrigin"),
            _mod.Mirror, new ExternalChangeWatcher(), SharedSchemaReflector.Instance, loggerFactory);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(503, problem.StatusCode);
    }
}
