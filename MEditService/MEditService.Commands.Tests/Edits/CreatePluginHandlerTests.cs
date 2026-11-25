using System.Security.Cryptography;
using MEditService.Codec.Schema;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
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
        _holder.Apply(SnapshotPlugins.Snapshot(_data.DataFolder, _data.InstanceRoot, GameRelease.Fallout4, _data.Plugins));

    public void Dispose() => _data.Dispose();

    private CreatePluginHandler Handler => TestEditService.PluginCreateHandler(_holder);

    private string ModFolder(string name) => Directory.CreateDirectory(Path.Combine(_data.DataFolder, name)).FullName;

    private Task<Answer<PluginCreated, PluginCreateRefused>> Create(string name, string folder, string origin) =>
        Handler.CreatePlugin(new PluginAddress(name, origin), folder, origin == LoadOrderEntry.OverwriteOrigin ? null : folder, []);

    [Fact]
    public async Task CreatePlugin_WritesTheFileInTheFolder_AnswersIt_AndChangesNothingElse()
    {
        var folder = ModFolder("QuietMod");
        var before = _holder.Current;
        var version = _holder.Held?.Version;
        var changes = 0;
        _holder.Arrived += (_, _) => changes++;

        var result = await Create("NewPlugin.esp", folder, "QuietMod");

        Assert.Equal([Path.Combine(folder, "NewPlugin.esp")], result.Created().Written);
        Assert.Same(before, _holder.Current);
        Assert.Equal(version, _holder.Held?.Version);
        Assert.Equal(0, changes);
        Assert.False(TestAdapters.Source().IsSourceMod(folder));
        Assert.Equal(["NewPlugin.esp"], Directory.EnumerateFileSystemEntries(folder).Select(Path.GetFileName));
        Assert.Empty(Directory.EnumerateFiles(
            _data.InstanceRoot, "plugins.txt", new EnumerationOptions { MatchCasing = MatchCasing.CaseInsensitive, RecurseSubdirectories = true }));
    }

    private async Task<string> SourceModWith(string name, string existing)
    {
        var folder = ModFolder(name);
        await Create(existing, folder, name);
        _holder.Apply(SnapshotPlugins.Snapshot(_data.DataFolder, _data.InstanceRoot, GameRelease.Fallout4,
        [
            .. _data.Plugins,
            new LoadOrderEntry(existing, Path.Combine(folder, existing), name, Line: 1, Enabled: true, Winning: true),
        ]));
        var committed = (await TestEditService.VersionInGitHandler(_holder).VersionInGitAsync(ToVersionInGit.In(_holder.Held?.Snapshot, name))).Value();
        Assert.Single(committed.Applied);
        return folder;
    }

    private static RegisteredPlugin Registered(string name, string origin, string folder) =>
        new(name, origin, Path.Combine(folder, name), new PluginProvider.FromMod(origin, folder, folder), Line: null, PluginStrings.None);

    [Fact]
    public async Task CreatePlugin_IntoASourceMod_LandsItsSourceAsWorkingTreeChanges_ParksTheBinaryItWasReadFrom_AndLeavesTheOthersAsTheyWere()
    {
        var folder = await SourceModWith("SourceMod", "First.esp");
        var first = new PluginAddress("First.esp", "SourceMod");
        var firstBefore = SourceModTree.Records(folder, first);
        var headBefore = Head(folder);

        var result = await Create("Second.esp", folder, "SourceMod");

        var written = result.Created().Written;
        WrittenPaths.Cover(written, Path.Combine(folder, "Second.esp"), Path.Combine(folder, ".git"), Path.Combine(folder, "plugin-source", "Second.esp"));
        WrittenPaths.Within(written, folder);
        Assert.Equal(firstBefore, SourceModTree.Records(folder, first));
        Assert.True(TestAdapters.Source().SourceReads(Registered("Second.esp", "SourceMod", folder)));
        Assert.Equal(headBefore, Head(folder));
        Assert.Equal(
            [Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.Combine(folder, "Second.esp"))))],
            TestAdapters.Source().OverFolder(new PluginProvider.FromMod("SourceMod", folder, folder), GameRelease.Fallout4).LastWrittenBinarySha256s(new PluginAddress("Second.esp", "SourceMod")).Value());
    }

    [Fact]
    public async Task CreatePlugin_OfAPluginTheSourceModsPluginSourceHolds_WithNoBinary_IsRefusedNamingIt_AndLeavesItsSource()
    {
        const string name = "First.esp";
        var folder = await SourceModWith("SourcedMod", "First.esp");
        var first = new PluginAddress("First.esp", "SourcedMod");
        var sourceBefore = string.Join(", ", SourceModTree.Records(folder, first));
        File.Delete(Path.Combine(folder, "First.esp"));

        var result = (await Create(name, folder, "SourcedMod")).Refused();

        Assert.Equal(
            (new PluginCreateRefused(PluginCreateRefusal.CompiledPlugin, $"'{folder}' already holds plugin source for {name}, so it was not created."),
                sourceBefore, false),
            (result, string.Join(", ", SourceModTree.Records(folder, first)), File.Exists(Path.Combine(folder, name))));
    }

    [Fact]
    public async Task CreatePlugin_WhoseSourceCannotBeWritten_TakesBackTheFileItWrote_AndWritesNothing()
    {
        var folder = await SourceModWith("FailingMod", "First.esp");
        var adapter = new SourceUnreadableAdapter();

        var result = (await TestEditService.PluginCreateHandler(_holder, adapter).CreatePlugin(new PluginAddress("Second.esp", "FailingMod"), folder, folder, [])).Refused();

        Assert.Equal(PluginCreateRefusal.WriteFailed, result.Refusal);
        Assert.Contains("Second.esp", result.Message, StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(folder, "Second.esp")));
        Assert.False(TestAdapters.Source().SourceReads(Registered("Second.esp", "FailingMod", folder)));
    }

    private static string Head(string folder) =>
        GitProbe.Run(Path.Combine(folder, ".git"), folder, "rev-parse", "HEAD").Trim();

    [Fact]
    public async Task CreatePlugin_IntoOverwrite_WritesNoSource_EvenWhereTheFolderHoldsARepository()
    {
        var folder = await SourceModWith("HostMod", "First.esp");

        var result = await Create("Second.esp", folder, LoadOrderEntry.OverwriteOrigin);

        result.Created();
        Assert.True(File.Exists(Path.Combine(folder, "Second.esp")));
        Assert.False(TestAdapters.Source().SourceReads(Registered("Second.esp", "HostMod", folder)));
    }

    [Fact]
    public async Task CreatePlugin_WhoseSourceWriteFails_TakesBackTheFile_AndLeavesNoPartialTree()
    {
        var folder = await SourceModWith("BlockedMod", "First.esp");
        var blocker = Path.Combine(folder, "plugin-source", "Second.esp");
        File.WriteAllText(blocker, "not a folder");

        var result = (await Create("Second.esp", folder, "BlockedMod")).Refused();

        Assert.Equal(PluginCreateRefusal.WriteFailed, result.Refusal);
        Assert.False(File.Exists(Path.Combine(folder, "Second.esp")));
        Assert.Equal(["not a folder"], Directory.EnumerateFileSystemEntries(Path.Combine(folder, "plugin-source"), "Second.esp").Select(File.ReadAllText));
    }

    [Fact]
    public async Task CreatePlugin_WhoseFileChangedBeforeTheTakeBack_LeavesItAndNamesIt()
    {
        var folder = await SourceModWith("ChangedMod", "First.esp");
        var created = Path.Combine(folder, "Second.esp");
        var adapter = new SourceUnreadableAdapter { Before = () => File.WriteAllText(created, "another tool's file") };

        var result = (await TestEditService.PluginCreateHandler(_holder, adapter).CreatePlugin(new PluginAddress("Second.esp", "ChangedMod"), folder, folder, [])).Refused();

        Assert.Equal(PluginCreateRefusal.WriteFailed, result.Refusal);
        Assert.Contains("left in", result.Message, StringComparison.Ordinal);
        Assert.Contains("Second.esp", result.Message, StringComparison.Ordinal);
        Assert.Equal("another tool's file", File.ReadAllText(created));
    }

    [Fact]
    public async Task CreatePlugin_WhoseTakeBackFails_RefusesWithBothCauses()
    {
        var folder = await SourceModWith("LockedMod", "First.esp");
        var takeBackFailure = PluginFailures.Inaccessible();
        var adapter = new SourceUnreadableAdapter { TakeBackFailure = takeBackFailure };

        var result = (await TestEditService.PluginCreateHandler(_holder, adapter).CreatePlugin(new PluginAddress("Second.esp", "LockedMod"), folder, folder, [])).Refused();

        Assert.Equal(PluginCreateRefusal.WriteFailed, result.Refusal);
        Assert.Contains(adapter.Unread.Reason, result.Message, StringComparison.Ordinal);
        Assert.Contains(takeBackFailure.Reason, result.Message, StringComparison.Ordinal);
        Assert.True(File.Exists(Path.Combine(folder, "Second.esp")));
    }

    private sealed class SourceUnreadableAdapter() : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public Action? Before { get; init; }
        public PluginFailure? TakeBackFailure { get; init; }
        public PluginFailure Unread { get; } = PluginFailures.Unparsed();

        public override Task<Answer<PluginSource, PluginFailure>> ReadSourceOfAsync(
            RegisteredPlugin plugin, LoadOrderSnapshot loadOrder, CancellationToken cancel = default)
        {
            Before?.Invoke();
            return Task.FromResult<Answer<PluginSource, PluginFailure>>(Unread);
        }

        public override Answer<EmptyPluginTakeBack, PluginFailure> TakeBackEmpty(ModKey modKey, string folder, string written) =>
            TakeBackFailure ?? base.TakeBackEmpty(modKey, folder, written);
    }

    [Fact]
    public async Task CreatePlugin_IntoAFolderThatHasGone_IsRefusedNamingIt_AndMakesNoFolder()
    {
        var gone = Path.Combine(_data.DataFolder, "GoneMod");

        var result = (await Create("New.esp", gone, "GoneMod")).Refused();

        Assert.Equal(PluginCreateRefusal.FolderGone, result.Refusal);
        Assert.Contains(gone, result.Message, StringComparison.Ordinal);
        Assert.False(Directory.Exists(gone));
    }

    [Fact]
    public async Task CreatePlugin_OverAFileSpelledInAnotherCase_IsRefusedNamingItAsItIsSpelled_AndLeavesItAsItWas()
    {
        var folder = ModFolder("OccupiedMod");
        File.WriteAllText(Path.Combine(folder, "occupied.ESP"), "another tool's file");

        var result = (await Create("Occupied.esp", folder, "OccupiedMod")).Refused();

        Assert.Equal(
            (new PluginCreateRefused(PluginCreateRefusal.FileExists, $"{folder} already holds occupied.ESP, so Occupied.esp was not created."),
                "occupied.ESP"),
            (result, string.Join(", ", Directory.GetFiles(folder).Select(Path.GetFileName))));
    }

    [Fact]
    public async Task CreatePlugin_ALightPluginInAReleaseWithoutThem_IsRefusedNamingIt_BeforeAnyWrite()
    {
        var folder = ModFolder("LightMod");

        var result = (await HandlerIn(GameRelease.Oblivion).CreatePlugin(new PluginAddress("Light.esl", "LightMod"), folder, folder)).Refused();

        Assert.Equal(
            (new PluginCreateRefused(PluginCreateRefusal.LightPluginUnsupported, "Oblivion has no light plugins, so Light.esl cannot be created."), false),
            (result, Directory.EnumerateFileSystemEntries(folder).Any()));
    }

    [Theory]
    [InlineData("sub/Mod.esp", "sub/Mod.esp is not a plugin file name: it holds a folder, or a character a plugin's name cannot.")]
    [InlineData(".esp", ".esp is not a plugin file name: it holds no name before its extension.")]
    [InlineData("Mod.txt", "Mod.txt is not a plugin file: its extension must be .esm, .esl or .esp.")]
    public async Task CreatePlugin_ANameThatIsNoPluginFileName_IsRefusedSayingWhy_BeforeAnyWrite(string name, string why)
    {
        var folder = ModFolder("BadMod");

        var result = (await Handler.CreatePlugin(new PluginAddress(name, "BadMod"), folder, folder)).Refused();

        Assert.Equal(
            (new PluginCreateRefused(PluginCreateRefusal.NotAPluginFile, why), false),
            (result, Directory.EnumerateFileSystemEntries(folder).Any()));
    }

    [Fact]
    public async Task CreatePlugin_WhenTheFileSystemRefusesTheWrite_RefusesWithItsWords()
    {
        var failure = PluginFailures.Inaccessible();
        var adapter = new FailingWriteAdapter(failure);

        var result = (await HandlerIn(GameRelease.Fallout4, adapter).CreatePlugin(new PluginAddress("Full.esp", "FullMod"), ModFolder("FullMod"), ModFolder("FullMod"), [])).Refused();

        Assert.Equal(PluginCreateRefusal.WriteFailed, result.Refusal);
        Assert.Contains("Full.esp", result.Message, StringComparison.Ordinal);
        Assert.Contains(failure.Reason, result.Message, StringComparison.Ordinal);
    }

    private static IModFlagsGetter Header(string folder, string name) =>
        ModFactory.ImportGetter(new ModPath(ModKey.FromFileName(name), Path.Combine(folder, name)), GameRelease.Fallout4);

    [Theory]
    [InlineData("Small.esp", new[] { "Small" }, false, true)]
    [InlineData("Light.esl", null, true, true)]
    public async Task CreatePlugin_WritesTheFlagsPicked_OrTheOneCombinationItsExtensionImplies_InTheHeader(
        string name, string[]? flags, bool master, bool small)
    {
        var folder = ModFolder("FlagsMod");

        (await Handler.CreatePlugin(new PluginAddress(name, "FlagsMod"), folder, folder, flags)).Created();

        var header = Header(folder, name);
        Assert.Equal((master, small), (header.IsMaster, header.IsSmallMaster));
    }

    [Theory]
    [InlineData(null, PluginCreateRefusal.FlagsNeeded)]
    [InlineData(new[] { "Medium" }, PluginCreateRefusal.FlagsNotOffered)]
    [InlineData(new[] { "Bogus" }, PluginCreateRefusal.FlagsNotOffered)]
    public async Task CreatePlugin_OfAnEsp_WithNoFlags_OrFlagsItsExtensionDoesNotOffer_IsRefused_AndWritesNothing(
        string[]? flags, PluginCreateRefusal refusal)
    {
        var folder = ModFolder("FlagsMod");

        var result = (await Handler.CreatePlugin(new PluginAddress("Plain.esp", "FlagsMod"), folder, folder, flags)).Refused();

        Assert.Equal((refusal, false), (result.Refusal, Directory.EnumerateFileSystemEntries(folder).Any()));
    }

    private CreatePluginHandler HandlerIn(GameRelease release, IPluginAdapter? adapter = null)
    {
        var holder = new LoadOrderHolder();
        holder.Apply(SnapshotPlugins.Snapshot(_data.DataFolder, _data.InstanceRoot, release, _data.Plugins));
        return TestEditService.PluginCreateHandler(holder, adapter);
    }

    private sealed class FailingWriteAdapter(PluginFailure failure) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public override Task<Answer<EmptyPluginCreated, PluginFailure>> CreateAndWriteAsync(
            ModKey modKey, string folder, GameRelease gameRelease, IReadOnlyCollection<HeaderFlag> flags) =>
            Task.FromResult<Answer<EmptyPluginCreated, PluginFailure>>(failure);
    }
}
