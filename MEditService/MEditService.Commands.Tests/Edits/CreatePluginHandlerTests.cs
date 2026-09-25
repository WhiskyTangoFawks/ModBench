using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

public sealed class CreatePluginHandlerTests : IDisposable
{
    private readonly PluginFixtureData _data = new PluginFixtureBuilder("create-plugin-handler")
        .WithPlugin("Base.esp")
        .Build();

    private readonly LoadOrderHolder _holder = new();

    public CreatePluginHandlerTests() =>
        _holder.Apply(new LoadOrderSnapshot(_data.DataFolder, _data.InstanceRoot, GameRelease.Fallout4, SnapshotPlugins.Of(_data.Plugins)));

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
        Assert.Equal(Path.Combine(folder, "NewPlugin.esp"), result.Path);
        Assert.True(File.Exists(result.Path));
    }

    [Theory]
    [InlineData("Plain.esp", false, false)]
    [InlineData("Master.esm", true, false)]
    [InlineData("Light.esl", false, true)]
    public async Task CreatePlugin_WritesAnEmptyPluginWhoseFlagsTheExtensionAloneSets(string name, bool master, bool light)
    {
        var folder = ModFolder("FlagsMod");

        await Create(name, folder, "FlagsMod");

        using var written = Written(folder, name);
        Assert.Equal((master, light), (written.IsMaster, written.IsSmallMaster));
        Assert.Empty(written.EnumerateMajorRecords());
        Assert.Empty(written.MasterReferences);
    }

    [Fact]
    public async Task CreatePlugin_ChangesNothingElse()
    {
        var folder = ModFolder("QuietMod");
        var before = _holder.Current;
        var version = _holder.Version;
        var changes = 0;
        _holder.Changed += (_, _) => changes++;

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
    public async Task CreatePlugin_IntoATrackedMod_LeavesItsRepositoryAsItWas()
    {
        var folder = ModFolder("TrackedMod");
        await Create("First.esp", folder, "TrackedMod");
        _holder.Apply(new LoadOrderSnapshot(_data.DataFolder, _data.InstanceRoot, GameRelease.Fallout4,
        [
            .. SnapshotPlugins.Of(_data.Plugins),
            new RegisteredPlugin("First.esp", "TrackedMod", Path.Combine(folder, "First.esp"), Slot: 1, Enabled: true, Winning: true),
        ]));
        var tracked = await TestEditService.TrackHandler(_holder)
            .TrackAsync([new PluginAddress("First.esp", "TrackedMod")], SourcePreset.Edits);
        Assert.True(tracked.AllApplied);
        var repository = TreeSnapshot.Of(Path.Combine(folder, ".git"));

        var result = await Create("Second.esp", folder, "TrackedMod");

        Assert.True(result.Applied);
        Assert.Equal(repository, TreeSnapshot.Of(Path.Combine(folder, ".git")));
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
        Assert.Contains(occupied, result.Message, StringComparison.Ordinal);
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

    // The rival refuses by the release alone: a release with no light plugins still takes a full one.
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

    private CreatePluginHandler HandlerIn(GameRelease release, RecordingAdapter adapter)
    {
        var holder = new LoadOrderHolder();
        holder.Apply(new LoadOrderSnapshot(_data.DataFolder, _data.InstanceRoot, release, SnapshotPlugins.Of(_data.Plugins)));
        return TestEditService.PluginCreateHandler(holder, adapter);
    }

    // Answers written without writing, so a release this build carries no Mutagen game module for
    // still reaches the adapter.
    private sealed class RecordingAdapter : ReadOnlyPluginAdapter
    {
        public List<(string Name, GameRelease Release)> Asked { get; } = [];

        public override Task<EmptyPluginWrite> CreateAndWriteAsync(ModKey modKey, string destinationPath, GameRelease gameRelease)
        {
            Asked.Add((modKey.FileName.String, gameRelease));
            return Task.FromResult(EmptyPluginWrite.Written);
        }
    }

    private static IModDisposeGetter Written(string folder, string name) =>
        ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(name), Path.Combine(folder, name)), GameRelease.Fallout4);
}
