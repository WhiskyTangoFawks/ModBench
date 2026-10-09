using System.Security.Cryptography;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;
using Noggog.WorkEngine;

namespace MEditService.Commands.Tests.Source;

public sealed class TrackCommitShapeTests : IDisposable
{
    private const string ModName = "TwoPluginMod";
    private readonly ScratchDirectory _root = new("medit-track-shape-");
    private readonly string _modFolder;
    private readonly string _gameDir;

    public TrackCommitShapeTests()
    {
        _modFolder = Directory.CreateDirectory(Path.Combine(_root, ModName)).FullName;
        _gameDir = Directory.CreateDirectory(Path.Combine(_root, "game")).FullName;
    }

    public void Dispose() => _root.Dispose();

    [Fact]
    public async Task Track_ParksEachPluginsBinary_SoNoPluginReadsAsChangedOutsideModbench()
    {
        WritePluginReturningItsBinarySha256("First.esp", "FirstNpc");
        WritePluginReturningItsBinarySha256("Second.esp", "SecondNpc");

        await Track();

        Assert.Empty(ExternalChanges.NamedBy(LoadOrder()));
    }

    [Fact]
    public async Task Track_OfAPluginInAModThatAlreadyHasARepository_RefusesTheMod_PointingAtDecompile_AndCommitsNothing()
    {
        WritePluginReturningItsBinarySha256("First.esp", "FirstNpc");
        await Track();
        var firstBefore = HeldBy("First.esp");
        WritePluginReturningItsBinarySha256("Second.esp", "SecondNpc");

        var result = await Track();

        Assert.Empty(result.Landed);
        var refused = Assert.Single(result.Refused);
        Assert.Equal((ModName, TrackRefusal.AlreadyTracked), (refused.Item, refused.Refusal));
        Assert.Contains("decompile", refused.Message, StringComparison.Ordinal);
        Assert.Equal(firstBefore, HeldBy("First.esp"));
        Assert.Empty(HeldBy("Second.esp"));
    }

    [Fact]
    public async Task Track_IntoAModWhoseRepositoryHasHistoryButNoMain_RefusesTheMod_AndChangesNothingOfTheRepository()
    {
        WritePluginReturningItsBinarySha256("First.esp", "FirstNpc");
        Git("init", "-q", "-b", "master");
        File.WriteAllText(Path.Combine(_modFolder, ".gitignore"), "theirs\n");
        Git("add", ".gitignore");
        Git("-c", "user.name=Them", "-c", "user.email=them@localhost", "commit", "-q", "-m", "Their own commit");
        var gitignoreBefore = File.ReadAllBytes(Path.Combine(_modFolder, ".gitignore"));

        var result = await Track();

        Assert.Empty(result.Landed);
        var refused = Assert.Single(result.Refused);
        Assert.Equal((ModName, TrackRefusal.AlreadyTracked), (refused.Item, refused.Refusal));
        Assert.Contains(_modFolder, refused.Message, StringComparison.Ordinal);
        Assert.Empty(SourceRepository.Over(new PluginProvider.FromMod(ModName, _modFolder), GameRelease.Fallout4).FormKeysUsed(Key("First.esp")));
        Assert.Empty(HeldBy("First.esp"));
        Assert.Equal(gitignoreBefore, File.ReadAllBytes(Path.Combine(_modFolder, ".gitignore")));
    }

    [Fact]
    public async Task Track_OfAModWhereOnePluginFailsItsRoundTripGate_RefusesTheWholeMod_WritingNothing()
    {
        WritePluginReturningItsBinarySha256("First.esp", "FirstNpc");
        WritePluginReturningItsBinarySha256("Second.esp", "SecondNpc");
        WritePluginReturningItsBinarySha256("Third.esp", "ThirdNpc");

        var result = await Track(new RoundTripFailsFor("Second.esp"));

        Assert.Empty(result.Landed);
        var refusedMod = Assert.Single(result.Refused);
        Assert.Equal(TrackRefusal.RoundTripFailed, refusedMod.Refusal);
        Assert.Contains("SecondNpc", refusedMod.Message, StringComparison.Ordinal);
        Assert.False(SourceRepository.IsTracked(_modFolder));
        Assert.Empty(HeldBy("First.esp"));
        Assert.Empty(HeldBy("Third.esp"));
    }

    [Fact]
    public async Task Track_OfAModWhereTwoPluginsAreRefused_NamesEachRefusedPluginAndNoOther()
    {
        WritePluginReturningItsBinarySha256("First.esp", "FirstNpc");
        WritePluginReturningItsBinarySha256("Second.esp", "SecondNpc");
        WritePluginReturningItsBinarySha256("Third.esp", "ThirdNpc");

        var result = await Track(new RoundTripFailsForEvery("First.esp", "Third.esp"));

        var refusedMod = Assert.Single(result.Refused);
        Assert.Contains("First.esp", refusedMod.Message, StringComparison.Ordinal);
        Assert.Contains("Third.esp", refusedMod.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("Second.esp", refusedMod.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Track_OfASelectionWhereEveryPluginIsRefused_CreatesNoRepository()
    {
        WritePluginReturningItsBinarySha256("Second.esp", "SecondNpc");

        var result = await Track(new RoundTripFailsFor("Second.esp"));

        Assert.Empty(result.Landed);
        var refusedMod = Assert.Single(result.Refused);
        Assert.Equal(TrackRefusal.RoundTripFailed, refusedMod.Refusal);
        Assert.Contains("SecondNpc", refusedMod.Message, StringComparison.Ordinal);
        Assert.False(SourceRepository.IsTracked(_modFolder));
    }

    [Fact]
    public async Task Track_OfAModWhoseEveryPluginIsRefusedForOneCause_KeepsThatCauseAsTheModsRefusal()
    {
        WritePluginReturningItsBinarySha256("First.esp", "FirstNpc");
        WritePluginReturningItsBinarySha256("Second.esp", "SecondNpc");

        var result = await Track(new RoundTripFailsForEvery("First.esp", "Second.esp"));

        var refused = Assert.Single(result.Refused);
        Assert.Equal((ModName, TrackRefusal.RoundTripFailed), (refused.Item, refused.Refusal));
        Assert.Contains("FirstNpc", refused.Message, StringComparison.Ordinal);
        Assert.Contains("SecondNpc", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Track_OfAModWhoseEveryPluginIsRefusedForDifferentCauses_RefusesTheModAsPluginsRefused_NamingEachReason()
    {
        WritePluginReturningItsBinarySha256("First.esp", "FirstNpc");
        WriteLocalizedPluginWithoutItsStrings("Second.esp");

        var result = await Track(new RoundTripFailsFor("First.esp"));

        var refused = Assert.Single(result.Refused);
        Assert.Equal((ModName, TrackRefusal.PluginsRefused), (refused.Item, refused.Refusal));
        Assert.Contains("FirstNpc", refused.Message, StringComparison.Ordinal);
        Assert.Contains("Second_en.STRINGS", refused.Message, StringComparison.Ordinal);
        Assert.False(SourceRepository.IsTracked(_modFolder));
    }

    private sealed class RoundTripFailsForEvery(params string[] plugins) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public override Task WriteFromTreeAsync(
            IReadOnlyList<TreeFile> files, string destinationPath,
            IReadOnlyList<string> masterOrder, CancellationToken cancel = default) =>
            plugins.FirstOrDefault(plugin => files.Any(file => file.RelativePath.StartsWith(PluginSourceRoot.For(plugin), StringComparison.Ordinal))) is { } failing
                ? new ForgedTreeWriteAdapter(failing, DeserializeThenCorruptTheNpc).WriteFromTreeAsync(files, destinationPath, masterOrder, cancel)
                : TestAdapters.Mutagen().WriteFromTreeAsync(files, destinationPath, masterOrder, cancel);

        private static async Task<IMod> DeserializeThenCorruptTheNpc(string folder, CancellationToken cancel)
        {
            var deserialized = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, cancel);
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
        public override Task WriteFromTreeAsync(
            IReadOnlyList<TreeFile> files, string destinationPath,
            IReadOnlyList<string> masterOrder, CancellationToken cancel = default) =>
            files.Any(file => file.RelativePath.StartsWith(PluginSourceRoot.For(plugin), StringComparison.Ordinal))
                ? new ForgedTreeWriteAdapter(plugin, DeserializeThenCorruptTheNpc).WriteFromTreeAsync(files, destinationPath, masterOrder, cancel)
                : TestAdapters.Mutagen().WriteFromTreeAsync(files, destinationPath, masterOrder, cancel);

        private static async Task<IMod> DeserializeThenCorruptTheNpc(string folder, CancellationToken cancel)
        {
            var deserialized = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, cancel);
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

    private static PluginAddress Key(string plugin) => new(plugin, ModName);

    private Task<SelectionResult<string, TrackRefusal, TrackedMod>> Track() => Track(TestAdapters.Mutagen());

    private Task<SelectionResult<string, TrackRefusal, TrackedMod>> Track(IPluginAdapter adapter) =>
        TrackEveryPluginOf.ModAsync(LoadOrder(), ModName, adapter);

    private LoadOrderSnapshot LoadOrder()
    {
        var entries = Directory.GetFiles(_modFolder, "*.esp")
            .Order(StringComparer.Ordinal)
            .Select((path, line) => new LoadOrderEntry(Path.GetFileName(path), path, ModName, line, Enabled: true, Winning: true))
            .ToList();
        return SnapshotPlugins.Snapshot(_gameDir, _gameDir, GameRelease.Fallout4, entries);
    }

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);

    private IReadOnlyList<SourceDocument> HeldBy(string plugin) =>
        TreeDocuments.Of(SourceRepository.Over(new PluginProvider.FromMod(ModName, _modFolder), GameRelease.Fallout4), Key(plugin));
}
