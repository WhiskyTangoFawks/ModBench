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
    private readonly string _gameDir;

    public DecompileAndCommitShapeTests()
    {
        _modFolder = Directory.CreateDirectory(Path.Combine(_root, ModName)).FullName;
        _gameDir = Directory.CreateDirectory(Path.Combine(_root, "game")).FullName;
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
    public async Task Init_HandsTheAdapterTheHashOfTheBytesEachPluginsSourceWasReadFrom()
    {
        WritePluginReturningItsBinarySha256("First.esp", "FirstNpc");
        var source = new FakeSourceAdapter();

        await Init(new ReadingAs("READ-FROM"), source);

        var (_, handedOver, _) = Assert.Single(source.InitCalls);
        Assert.Equal([("First.esp", "READ-FROM")], handedOver.Select(handed => (handed.Plugin.Plugin, handed.Plugin.BinarySha256)));
    }

    [Fact]
    public async Task Init_OfAPluginInAModThatAlreadyHasARepository_RefusesTheMod_PointingAtDecompile_AndCommitsNothing()
    {
        WritePluginReturningItsBinarySha256("First.esp", "FirstNpc");
        WritePluginReturningItsBinarySha256("Second.esp", "SecondNpc");
        var source = new FakeSourceAdapter().WithSourceMod(_modFolder);

        var result = await Init(TestAdapters.Mutagen(), source);

        Assert.Empty(result.Applied);
        var refused = Assert.Single(result.Refused);
        Assert.Equal((ModName, DecompileAndCommitRefusal.AlreadyInitialized), (refused.Item, refused.Refusal));
        Assert.Contains("decompile", refused.Message, StringComparison.Ordinal);
        Assert.Empty(source.InitCalls);
    }

    [Fact]
    public async Task Init_IntoAModWhoseRepositoryHasHistoryButNoMain_RefusesTheMod_AndChangesNothingOfTheRepository()
    {
        WritePluginReturningItsBinarySha256("First.esp", "FirstNpc");
        var source = new FakeSourceAdapter().HoldingAnotherRepository(_modFolder);

        var result = await Init(TestAdapters.Mutagen(), source);

        Assert.Empty(result.Applied);
        var refused = Assert.Single(result.Refused);
        Assert.Equal((ModName, DecompileAndCommitRefusal.AlreadyInitialized), (refused.Item, refused.Refusal));
        Assert.Contains(_modFolder, refused.Message, StringComparison.Ordinal);
        Assert.Empty(source.InitCalls);
    }

    [Fact]
    public async Task Init_OfAModWhereOnePluginFailsItsRoundTripGate_RefusesTheWholeMod_WritingNothing()
    {
        WritePluginReturningItsBinarySha256("First.esp", "FirstNpc");
        WritePluginReturningItsBinarySha256("Second.esp", "SecondNpc");
        WritePluginReturningItsBinarySha256("Third.esp", "ThirdNpc");

        var source = new FakeSourceAdapter();

        var result = await Init(new RoundTripFailsFor("Second.esp"), source);

        Assert.Empty(result.Applied);
        var refusedMod = Assert.Single(result.Refused);
        Assert.Equal(DecompileAndCommitRefusal.RoundTripFailed, refusedMod.Refusal);
        Assert.Contains("SecondNpc", refusedMod.Message, StringComparison.Ordinal);
        Assert.Empty(source.InitCalls);
    }

    [Fact]
    public async Task Init_OfAModWhereTwoPluginsAreRefused_NamesEachRefusedPluginAndNoOther()
    {
        WritePluginReturningItsBinarySha256("First.esp", "FirstNpc");
        WritePluginReturningItsBinarySha256("Second.esp", "SecondNpc");
        WritePluginReturningItsBinarySha256("Third.esp", "ThirdNpc");

        var result = await Init(new RoundTripFailsForEvery("First.esp", "Third.esp"));

        var refusedMod = Assert.Single(result.Refused);
        Assert.Contains("First.esp", refusedMod.Message, StringComparison.Ordinal);
        Assert.Contains("Third.esp", refusedMod.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("Second.esp", refusedMod.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Init_OfASelectionWhereEveryPluginIsRefused_CreatesNoRepository()
    {
        WritePluginReturningItsBinarySha256("Second.esp", "SecondNpc");

        var source = new FakeSourceAdapter();

        var result = await Init(new RoundTripFailsFor("Second.esp"), source);

        Assert.Empty(result.Applied);
        var refusedMod = Assert.Single(result.Refused);
        Assert.Equal(DecompileAndCommitRefusal.RoundTripFailed, refusedMod.Refusal);
        Assert.Contains("SecondNpc", refusedMod.Message, StringComparison.Ordinal);
        Assert.Empty(source.InitCalls);
    }

    [Fact]
    public async Task Init_OfAModWhoseEveryPluginIsRefusedForOneCause_KeepsThatCauseAsTheModsRefusal()
    {
        WritePluginReturningItsBinarySha256("First.esp", "FirstNpc");
        WritePluginReturningItsBinarySha256("Second.esp", "SecondNpc");

        var result = await Init(new RoundTripFailsForEvery("First.esp", "Second.esp"));

        var refused = Assert.Single(result.Refused);
        Assert.Equal((ModName, DecompileAndCommitRefusal.RoundTripFailed), (refused.Item, refused.Refusal));
        Assert.Contains("FirstNpc", refused.Message, StringComparison.Ordinal);
        Assert.Contains("SecondNpc", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Init_OfAModWhoseEveryPluginIsRefusedForDifferentCauses_RefusesTheModAsPluginsRefused_NamingEachReason()
    {
        WritePluginReturningItsBinarySha256("First.esp", "FirstNpc");
        WriteLocalizedPluginWithoutItsStrings("Second.esp");

        var source = new FakeSourceAdapter();

        var result = await Init(new RoundTripFailsFor("First.esp"), source);

        var refused = Assert.Single(result.Refused);
        Assert.Equal((ModName, DecompileAndCommitRefusal.PluginsRefused), (refused.Item, refused.Refusal));
        Assert.Contains("FirstNpc", refused.Message, StringComparison.Ordinal);
        Assert.Contains("Second_en.STRINGS", refused.Message, StringComparison.Ordinal);
        Assert.Empty(source.InitCalls);
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

    private sealed class RoundTripFailsFor(string plugin) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public override Task<Answer<string, PluginFailure>> WriteFromTreeAsync(
            IReadOnlyList<TreeFile> files, string destinationPath,
            IReadOnlyList<string> masterOrder, LoadOrderSnapshot loadOrder, CancellationToken cancel = default) =>
            Path.GetFileName(destinationPath) == plugin
                ? new ForgedTreeWriteAdapter(DeserializeThenCorruptTheNpc).WriteFromTreeAsync(files, destinationPath, masterOrder, loadOrder, cancel)
                : TestAdapters.Mutagen().WriteFromTreeAsync(files, destinationPath, masterOrder, loadOrder, cancel);

        private static async Task<IMod> DeserializeThenCorruptTheNpc(string folder, CancellationToken cancel)
        {
            var deserialized = await Fallout4WholeMod.Deserialize(folder, cancel);
            deserialized.Npcs.First().EditorID += "Corrupted";
            return deserialized;
        }
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
        return SnapshotPlugins.Snapshot(_gameDir, _gameDir, GameRelease.Fallout4, entries);
    }

}
