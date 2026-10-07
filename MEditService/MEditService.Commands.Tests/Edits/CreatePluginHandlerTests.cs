using MEditService.Codec.Serialization;
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
            _data.InstanceRoot, "plugins.txt", new EnumerationOptions { MatchCasing = MatchCasing.CaseInsensitive, RecurseSubdirectories = true }));
    }

    private async Task<string> TrackedModWith(string name, string existing)
    {
        var folder = ModFolder(name);
        await Create(existing, folder, name);
        _holder.Apply(SnapshotPlugins.Snapshot(_data.DataFolder, _data.InstanceRoot, GameRelease.Fallout4,
        [
            .. _data.Plugins,
            new LoadOrderEntry(existing, Path.Combine(folder, existing), name, Slot: 1, Enabled: true, Winning: true),
        ]));
        var tracked = await TestEditService.TrackHandler(_holder).TrackAsync([name]);
        Assert.Empty(tracked.Refused);
        Assert.Single(tracked.Landed);
        return folder;
    }

    private static RegisteredPlugin Registered(string name, string origin, string folder) =>
        new(name, origin, Path.Combine(folder, name), new PluginProvider.FromMod(origin, folder));

    [Fact]
    public async Task CreatePlugin_IntoATrackedMod_LandsItsSourceAsWorkingTreeChanges_AndLeavesTheOthersAsTheyWere()
    {
        var folder = await TrackedModWith("TrackedMod", "First.esp");
        var first = new PluginAddress("First.esp", "TrackedMod");
        var firstBefore = TrackedTree.Records(folder, first);
        var headBefore = Head(folder);

        var result = await Create("Second.esp", folder, "TrackedMod");

        Assert.True(result.Applied);
        Assert.Equal(firstBefore, TrackedTree.Records(folder, first));
        Assert.True(SourceRepository.SourceReads(Registered("Second.esp", "TrackedMod", folder)));
        Assert.Equal(headBefore, Head(folder));
    }

    [Fact]
    public async Task CreatePlugin_WhoseSourceCannotBeWritten_TakesBackTheFileItWrote_AndWritesNothing()
    {
        var folder = await TrackedModWith("FailingMod", "First.esp");
        var adapter = new SourceUnreadableAdapter();

        var result = await TestEditService.PluginCreateHandler(_holder, adapter).CreatePlugin(new PluginAddress("Second.esp", "FailingMod"), folder);

        Assert.Equal(PluginCreateRefusal.WriteFailed, result.Refusal);
        Assert.Contains("Second.esp", result.Message, StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(folder, "Second.esp")));
        Assert.False(SourceRepository.SourceReads(Registered("Second.esp", "FailingMod", folder)));
    }

    private static string Head(string folder) =>
        GitProbe.Run(Path.Combine(folder, ".git"), folder, "rev-parse", "HEAD").Trim();

    [Fact]
    public async Task CreatePlugin_IntoOverwrite_WritesNoSource_EvenWhereTheFolderHoldsARepository()
    {
        var folder = await TrackedModWith("HostMod", "First.esp");

        var result = await Create("Second.esp", folder, PluginOrigin.Overwrite);

        Assert.True(result.Applied);
        Assert.True(File.Exists(Path.Combine(folder, "Second.esp")));
        Assert.False(SourceRepository.SourceReads(Registered("Second.esp", "HostMod", folder)));
    }

    [Fact]
    public async Task CreatePlugin_WhoseSourceWriteFails_TakesBackTheFile_AndLeavesNoPartialTree()
    {
        var folder = await TrackedModWith("BlockedMod", "First.esp");
        var blocker = Path.Combine(folder, "plugin-source", "Second.esp");
        File.WriteAllText(blocker, "not a folder");

        var result = await Create("Second.esp", folder, "BlockedMod");

        Assert.Equal(PluginCreateRefusal.WriteFailed, result.Refusal);
        Assert.False(File.Exists(Path.Combine(folder, "Second.esp")));
        Assert.Equal(["not a folder"], Directory.EnumerateFileSystemEntries(Path.Combine(folder, "plugin-source"), "Second.esp").Select(File.ReadAllText));
    }

    [Fact]
    public async Task CreatePlugin_WhoseFileChangedBeforeTheTakeBack_LeavesItAndNamesIt()
    {
        var folder = await TrackedModWith("ChangedMod", "First.esp");
        var created = Path.Combine(folder, "Second.esp");
        var adapter = new SourceUnreadableAdapter { Before = () => File.WriteAllText(created, "another tool's file") };

        var result = await TestEditService.PluginCreateHandler(_holder, adapter).CreatePlugin(new PluginAddress("Second.esp", "ChangedMod"), folder);

        Assert.Equal(PluginCreateRefusal.WriteFailed, result.Refusal);
        Assert.Contains("left in", result.Message, StringComparison.Ordinal);
        Assert.Contains("Second.esp", result.Message, StringComparison.Ordinal);
        Assert.Equal("another tool's file", File.ReadAllText(created));
    }

    [Fact]
    public async Task CreatePlugin_WhoseTakeBackFails_RefusesWithBothCauses()
    {
        var folder = await TrackedModWith("LockedMod", "First.esp");
        var adapter = new SourceUnreadableAdapter { TakeBackFailure = new IOException("locked") };

        var result = await TestEditService.PluginCreateHandler(_holder, adapter).CreatePlugin(new PluginAddress("Second.esp", "LockedMod"), folder);

        Assert.Equal(PluginCreateRefusal.WriteFailed, result.Refusal);
        Assert.Contains("unreadable", result.Message, StringComparison.Ordinal);
        Assert.Contains("locked", result.Message, StringComparison.Ordinal);
        Assert.True(File.Exists(Path.Combine(folder, "Second.esp")));
    }

    [Fact]
    public async Task CreatePlugin_IntoATrackedMod_ParksTheBinaryItsSourceWasReadFrom()
    {
        var folder = await TrackedModWith("ParkedMod", "First.esp");

        await Create("Second.esp", folder, "ParkedMod");

        Assert.Equal(
            [PluginBinaryHash.TrailerFormOfFile(Path.Combine(folder, "Second.esp"))],
            SourceRepository.Over(new PluginProvider.FromMod("ParkedMod", folder), GameRelease.Fallout4).LastWrittenBinarySha256s(new PluginAddress("Second.esp", "ParkedMod")));
    }

    private sealed class SourceUnreadableAdapter() : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public Action? Before { get; init; }
        public Exception? TakeBackFailure { get; init; }

        public override Task<(IReadOnlyList<TreeFile> Files, string? MissingStringsFile)> ReadSourceAsync(
            ModPath modPath, string registeredName, GameRelease gameRelease, PluginStrings strings, CancellationToken cancel = default)
        {
            Before?.Invoke();
            throw new IOException("unreadable");
        }

        public override EmptyPluginTakeBack TakeBackEmpty(ModKey modKey, string folder, string written) =>
            TakeBackFailure is { } failure ? throw failure : base.TakeBackEmpty(modKey, folder, written);
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
    [InlineData("Mod.txt")]
    [InlineData("Mod")]
    [InlineData("Mod.esp.bak")]
    public async Task CreatePlugin_ANameThatIsNotAPluginFile_IsRefusedNamingIt_BeforeAnyWrite(string name)
    {
        var adapter = new RecordingAdapter();

        var result = await HandlerIn(GameRelease.Fallout4, adapter).CreatePlugin(new PluginAddress(name, "BadMod"), ModFolder("BadMod"));

        Assert.Equal(PluginCreateRefusal.NotAPluginFile, result.Refusal);
        Assert.Contains(name, result.Message, StringComparison.Ordinal);
        Assert.Empty(adapter.Asked);
    }

    [Theory]
    [InlineData(GameRelease.Fallout4, "must be .esm, .esl or .esp.")]
    [InlineData(GameRelease.Oblivion, "must be .esm or .esp.")]
    public async Task CreatePlugin_ANonPluginName_IsRefusedNamingTheExtensionsTheReleaseTakes(GameRelease release, string expected)
    {
        var result = await HandlerIn(release, new RecordingAdapter()).CreatePlugin(new PluginAddress("Mod.txt", "BadMod"), ModFolder("BadMod"));

        Assert.EndsWith(expected, result.Message, StringComparison.Ordinal);
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
    public async Task CreatePlugin_WhenTheFileSystemRefusesTheWrite_RefusesWithItsWords()
    {
        var adapter = new RecordingAdapter { Failure = new IOException("disk full") };

        var result = await HandlerIn(GameRelease.Fallout4, adapter).CreatePlugin(new PluginAddress("Full.esp", "FullMod"), ModFolder("FullMod"));

        Assert.Equal(PluginCreateRefusal.WriteFailed, result.Refusal);
        Assert.Contains("Full.esp", result.Message, StringComparison.Ordinal);
        Assert.Contains("disk full", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CreatePlugin_WhoseAdapterAnswersAnUnnamedOutcome_ThrowsRatherThanReportingApplied()
    {
        var adapter = new RecordingAdapter { Outcome = (EmptyPluginCreated)(EmptyPluginWrite)99 };

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => HandlerIn(GameRelease.Fallout4, adapter).CreatePlugin(new PluginAddress("Odd.esp", "OddMod"), ModFolder("OddMod")));
    }

    private CreatePluginHandler HandlerIn(GameRelease release, RecordingAdapter adapter)
    {
        var holder = new LoadOrderHolder();
        holder.Apply(SnapshotPlugins.Snapshot(_data.DataFolder, _data.InstanceRoot, release, _data.Plugins));
        return TestEditService.PluginCreateHandler(holder, adapter);
    }

    private sealed class RecordingAdapter() : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public List<(string Name, GameRelease Release)> Asked { get; } = [];
        public EmptyPluginCreated Outcome { get; init; } = EmptyPluginWrite.Written;
        public Exception? Failure { get; init; }

        public override Task<EmptyPluginCreated> CreateAndWriteAsync(ModKey modKey, string folder, GameRelease gameRelease)
        {
            Asked.Add((modKey.FileName.String, gameRelease));
            if (Failure is not null) throw Failure;
            return Task.FromResult(Outcome);
        }
    }
}
