using System.Security.Cryptography;
using MEditService.Codec.Serialization;
using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;

namespace MEditService.Commands.Tests.Build;

public sealed class DecompileAndCommitShapeTests : IDisposable
{
    private const string ModName = "TwoPluginMod";
    private readonly ScratchDirectory _root = new("medit-init-shape-");
    private readonly string _modFolder;
    private readonly string _dataFolder;

    public DecompileAndCommitShapeTests()
    {
        _modFolder = Directory.CreateDirectory(Path.Combine(_root, ModName)).FullName;
        _dataFolder = Directory.CreateDirectory(Path.Combine(_root, "Data")).FullName;
    }

    public void Dispose() => _root.Dispose();

    [Fact]
    public async Task Init_ParksEachPluginsBinary_SoNoPluginReadsAsChangedOutsideModbench()
    {
        WritePluginReturningItsBinarySha256("First.esp", "FirstNpc");
        WritePluginReturningItsBinarySha256("Second.esp", "SecondNpc");

        await Init();

        Assert.Empty(ExternalChanges.NamedBy(LoadOrder()));
    }

    [Fact]
    public async Task Init_ParksTheHashOfTheBytesEachPluginsSourceWasReadFrom()
    {
        WritePluginReturningItsBinarySha256("First.esp", "FirstNpc");

        await Init(new ReadingAs("READ-FROM"));

        Assert.Equal(
            ["READ-FROM"],
            TestAdapters.Source().OverFolder(new PluginProvider.FromMod(ModName, _modFolder, _modFolder), GameRelease.Fallout4)
                .LastWrittenBinarySha256s(new PluginAddress("First.esp", ModName)).Value());
    }

    public static TheoryData<string, Func<string, ISourceAdapter>, string> FoldersHoldingARepository => new()
    {
        {
            "a source mod", folder => new FakeSourceAdapter().WithSourceMod(folder),
            "already holds a repository. To put a plugin's source into its working tree, decompile it."
        },
        {
            "a repository with no main", folder => new FakeSourceAdapter().HoldingAnotherRepository(folder),
            "already holds a repository with no main branch, made outside Modbench."
        },
    };

    [Theory]
    [MemberData(nameof(FoldersHoldingARepository))]
    public async Task Init_IntoAFolderThatAlreadyHoldsARepository_RefusesTheMod_AndInitsNothing(
        string _, Func<string, ISourceAdapter> holding, string reason)
    {
        WritePluginReturningItsBinarySha256("First.esp", "FirstNpc");
        WritePluginReturningItsBinarySha256("Second.esp", "SecondNpc");

        var result = await Init(TestAdapters.Mutagen(), holding(_modFolder));

        Assert.Empty(result.Applied);
        var refused = Assert.Single(result.Refused);
        Assert.Equal(
            (ModName, DecompileAndCommitRefusal.AlreadyInitialized, $"'{_modFolder}' {reason}"),
            (refused.Item, refused.Refusal, refused.Message));
    }

    public static TheoryData<string[], string[], string[], string[]> PluginsFailingTheRoundTripGate() => new()
    {
        { ["First", "Second", "Third"], ["Second"], ["SecondNpc"], [] },
        { ["First", "Second", "Third"], ["First", "Third"], ["First.esp", "Third.esp"], ["Second.esp"] },
        { ["Second"], ["Second"], ["SecondNpc"], [] },
        { ["First", "Second"], ["First", "Second"], ["FirstNpc", "SecondNpc"], [] },
    };

    [Theory]
    [MemberData(nameof(PluginsFailingTheRoundTripGate))]
    public async Task Init_OfAModWithPluginsThatFailTheRoundTripGate_RefusesTheWholeMod_NamingEachRefusedPluginAndNoOther_WritingNothing(
        string[] plugins, string[] failing, string[] named, string[] notNamed)
    {
        WritePluginsOf(plugins);
        var source = new FakeSourceAdapter();

        var result = await Init(new RoundTripFailsForEvery([.. failing.Select(plugin => $"{plugin}.esp")]), source);

        Assert.Empty(result.Applied);
        var refused = Assert.Single(result.Refused);
        Assert.Equal((ModName, DecompileAndCommitRefusal.RoundTripFailed), (refused.Item, refused.Refusal));
        Assert.Equal(named, named.Where(name => refused.Message.Contains(name, StringComparison.Ordinal)));
        Assert.DoesNotContain(notNamed, name => refused.Message.Contains(name, StringComparison.Ordinal));
        Assert.False(source.IsSourceMod(_modFolder));
    }

    [Fact]
    public async Task Init_OfAModWhoseEveryPluginIsRefusedForDifferentCauses_RefusesTheModAsPluginsRefused_NamingEachReason()
    {
        WritePluginReturningItsBinarySha256("First.esp", "FirstNpc");
        WriteLocalizedPluginWithoutItsStrings("Second.esp");

        var source = new FakeSourceAdapter();

        var result = await Init(new RoundTripFailsForEvery("First.esp"), source);

        var refused = Assert.Single(result.Refused);
        Assert.Equal((ModName, DecompileAndCommitRefusal.PluginsRefused), (refused.Item, refused.Refusal));
        Assert.Contains("FirstNpc", refused.Message, StringComparison.Ordinal);
        Assert.Contains("Second_en.STRINGS", refused.Message, StringComparison.Ordinal);
        Assert.False(source.IsSourceMod(_modFolder));
    }

    private sealed class RoundTripFailsForEvery(params string[] plugins) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public override Task<Answer<string, PluginFailure>> WriteFromTreeAsync(
            IReadOnlyList<TreeFile> files, string destinationPath,
            IReadOnlyList<string> masterOrder, LoadOrderSnapshot loadOrder, CancellationToken cancel = default) =>
            plugins.Contains(Path.GetFileName(destinationPath))
                ? new ForgedTreeWriteAdapter(DeserializeThenCorruptTheNpc).WriteFromTreeAsync(files, destinationPath, masterOrder, loadOrder, cancel)
                : TestAdapters.Mutagen().WriteFromTreeAsync(files, destinationPath, masterOrder, loadOrder, cancel);

        private static async Task<IMod> DeserializeThenCorruptTheNpc(string folder, CancellationToken cancel)
        {
            var deserialized = await Fallout4WholeMod.Deserialize(folder, cancel);
            deserialized.Npcs.First().EditorID += "Corrupted";
            return deserialized;
        }
    }

    private void WriteLocalizedPluginWithoutItsStrings(string name)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        mod.Doors.AddNew("MainDoor").Name = new TranslatedString(Language.English, "The Big Door");
        mod.UsingLocalization = true;
        mod.WriteToBinary(Path.Combine(_modFolder, name));
        Directory.Delete(Path.Combine(_modFolder, "Strings"), recursive: true);
    }

    private void WritePluginsOf(IEnumerable<string> plugins)
    {
        foreach (var plugin in plugins) WritePluginReturningItsBinarySha256($"{plugin}.esp", $"{plugin}Npc");
    }

    private string WritePluginReturningItsBinarySha256(string name, string editorId)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        mod.Npcs.AddNew(editorId);
        var path = Path.Combine(_modFolder, name);
        mod.WriteToBinary(path);
        return Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));
    }

    private Task<DecompileAndCommitResult> Init() => Init(TestAdapters.Mutagen());

    private async Task<DecompileAndCommitResult> Init(IPluginAdapter adapter, ISourceAdapter? source = null) =>
        (await DecompileAndCommitEveryPluginOf.ModAsync(LoadOrder(), ModName, adapter, source: source)).Value();

    private LoadOrderSnapshot LoadOrder()
    {
        var entries = Directory.GetFiles(_modFolder, "*.esp")
            .Order(StringComparer.Ordinal)
            .Select((path, line) => new LoadOrderEntry(Path.GetFileName(path), path, ModName, line, Enabled: true, Winning: true))
            .ToList();
        return SnapshotPlugins.Snapshot(_dataFolder, _dataFolder, GameRelease.Fallout4, entries);
    }

}
