using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class CreatePluginHandlerTests : IDisposable
{
    private readonly PluginFixtureData _data = new PluginFixtureBuilder("create-plugin-handler")
        .WithPlugin("Base.esp")
        .Build();

    private readonly LoadOrderHolder _holder = new();

    public CreatePluginHandlerTests() =>
        _holder.Apply(SnapshotPlugins.Snapshot(_data.DataFolder, _data.InstanceRoot, GameRelease.Fallout4, _data.Plugins));

    public void Dispose() => _data.Dispose();

    private CreatePluginHandler Handler => TestEditService.PluginCreateHandler(_holder);

    private string ModFolder(string name) => Directory.CreateDirectory(Path.Combine(_data.DataFolder, name)).FullName;

    private Task<PluginCreateResult> Create(string name, string folder, string origin) =>
        Handler.CreatePlugin(new PluginAddress(name, origin), folder);

    [Fact]
    public async Task CreatePlugin_WritesTheFileInTheFolder_AndAnswersApplied()
    {
        var folder = ModFolder("StateMod");

        var result = await Create("NewPlugin.esp", folder, "StateMod");

        Assert.True(result.Applied);
        Assert.True(File.Exists(Path.Combine(folder, "NewPlugin.esp")));
    }

    [Fact]
    public async Task CreatePlugin_ChangesNothingElse()
    {
        var folder = ModFolder("QuietMod");
        var before = _holder.Current;
        var version = _holder.Version;
        var changes = 0;
        _holder.Arrived += (_, _) => changes++;

        await Create("NewPlugin.esp", folder, "QuietMod");

        Assert.Same(before, _holder.Current);
        Assert.Equal(version, _holder.Version);
        Assert.Equal(0, changes);
        Assert.False(SourceRepository.IsTracked(folder));
        Assert.Equal(["NewPlugin.esp"], Directory.EnumerateFileSystemEntries(folder).Select(Path.GetFileName));
        Assert.Empty(Directory.EnumerateFiles(
            _data.CleanupRoot, "plugins.txt", new EnumerationOptions { MatchCasing = MatchCasing.CaseInsensitive, RecurseSubdirectories = true }));
    }

    [Fact]
    public async Task CreatePlugin_IntoATrackedMod_LeavesItsTrackedSourceAsItWas()
    {
        var folder = ModFolder("TrackedMod");
        await Create("First.esp", folder, "TrackedMod");
        _holder.Apply(SnapshotPlugins.Snapshot(_data.DataFolder, _data.InstanceRoot, GameRelease.Fallout4,
        [
            .. _data.Plugins,
            new LoadOrderEntry("First.esp", Path.Combine(folder, "First.esp"), "TrackedMod", Slot: 1, Enabled: true, Winning: true),
        ]));
        var tracked = await TestEditService.TrackHandler(_holder)
            .TrackAsync(["TrackedMod"]);
        Assert.True(tracked.AllApplied);
        var first = new PluginAddress("First.esp", "TrackedMod");
        var firstBefore = TrackedTree.Records(folder, first);

        var result = await Create("Second.esp", folder, "TrackedMod");

        Assert.True(result.Applied);
        Assert.Equal(firstBefore, TrackedTree.Records(folder, first));
        Assert.False(SourceRepository.HoldsTreeFor(folder, "Second.esp"));
    }

    [Fact]
    public async Task CreatePlugin_WithNoLoadOrderHeld_RefusesBeforeWritingAnything()
    {
        var folder = ModFolder("HomelessMod");
        var handler = TestEditService.PluginCreateHandler(new LoadOrderHolder());

        await Assert.ThrowsAsync<NoLoadOrderException>(
            () => handler.CreatePlugin(new PluginAddress("Homeless.esp", "HomelessMod"), folder));

        Assert.Empty(Directory.EnumerateFileSystemEntries(folder));
    }

    [Fact]
    public async Task CreatePlugin_IntoAFolderThatHasGone_IsRefusedNamingIt_AndMakesNoFolder()
    {
        var gone = Path.Combine(_data.DataFolder, "GoneMod");

        var result = await Create("New.esp", gone, "GoneMod");

        Assert.Equal(PluginCreateRefusal.FolderGone, result.Refusal);
        Assert.Contains(gone, result.Message, StringComparison.Ordinal);
        Assert.False(Directory.Exists(gone));
    }

    [Fact]
    public async Task CreatePlugin_OverAFileAlreadyThere_IsRefusedNamingIt_AndLeavesItAsItWas()
    {
        var folder = ModFolder("OccupiedMod");
        var occupied = Path.Combine(folder, "Occupied.esp");
        File.WriteAllText(occupied, "another tool's file");

        var result = await Create("Occupied.esp", folder, "OccupiedMod");

        Assert.Equal(PluginCreateRefusal.FileExists, result.Refusal);
        Assert.Contains(folder, result.Message, StringComparison.Ordinal);
        Assert.Contains("Occupied.esp", result.Message, StringComparison.Ordinal);
        Assert.Equal("another tool's file", File.ReadAllText(occupied));
    }

    [Theory]
    [InlineData(GameRelease.Oblivion)]
    [InlineData(GameRelease.OblivionRE)]
    public async Task CreatePlugin_ALightPluginInAReleaseWithoutThem_IsRefusedNamingIt_BeforeAnyWrite(GameRelease release)
    {
        var adapter = new RecordingAdapter();

        var result = await HandlerIn(release, adapter).CreatePlugin(new PluginAddress("Light.esl", "LightMod"), ModFolder("LightMod"));

        Assert.Equal(PluginCreateRefusal.LightPluginUnsupported, result.Refusal);
        Assert.Contains(release.ToString(), result.Message, StringComparison.Ordinal);
        Assert.Empty(adapter.Asked);
    }

    [Theory]
    [InlineData("Plain.esp")]
    [InlineData("Master.esm")]
    public async Task CreatePlugin_AFullPluginInAReleaseWithoutLightPlugins_IsWritten(string name)
    {
        var adapter = new RecordingAdapter();

        var result = await HandlerIn(GameRelease.Oblivion, adapter).CreatePlugin(new PluginAddress(name, "FullMod"), ModFolder("FullMod"));

        Assert.True(result.Applied);
        Assert.Equal([(name, GameRelease.Oblivion)], adapter.Asked);
    }

    [Fact]
    public async Task CreatePlugin_WhoseAdapterAnswersAnUnnamedOutcome_ThrowsRatherThanReportingApplied()
    {
        var adapter = new RecordingAdapter { Outcome = (EmptyPluginWrite)99 };

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => HandlerIn(GameRelease.Fallout4, adapter).CreatePlugin(new PluginAddress("Odd.esp", "OddMod"), ModFolder("OddMod")));
    }

    private CreatePluginHandler HandlerIn(GameRelease release, RecordingAdapter adapter)
    {
        var holder = new LoadOrderHolder();
        holder.Apply(SnapshotPlugins.Snapshot(_data.DataFolder, _data.InstanceRoot, release, _data.Plugins));
        return TestEditService.PluginCreateHandler(holder, adapter);
    }

    private sealed class RecordingAdapter : ReadOnlyPluginAdapter
    {
        public List<(string Name, GameRelease Release)> Asked { get; } = [];
        public EmptyPluginWrite Outcome { get; init; } = EmptyPluginWrite.Written;

        public override Task<EmptyPluginWrite> CreateAndWriteAsync(ModKey modKey, string folder, GameRelease gameRelease)
        {
            Asked.Add((modKey.FileName.String, gameRelease));
            return Task.FromResult(Outcome);
        }
    }
}
