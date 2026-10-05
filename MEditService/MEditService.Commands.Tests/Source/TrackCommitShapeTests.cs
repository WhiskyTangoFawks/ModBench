using System.Security.Cryptography;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
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
    public async Task Track_ParksEachPluginsBinary_UnderItsOwnName()
    {
        var first = WritePluginReturningItsBinarySha256("First.esp", "FirstNpc");
        var second = WritePluginReturningItsBinarySha256("Second.esp", "SecondNpc");

        await Track();

        Assert.Equal([first], LastWriteRecord.Of(_modFolder, "First.esp"));
        Assert.Equal([second], LastWriteRecord.Of(_modFolder, "Second.esp"));
    }

    [Fact]
    public async Task Track_OfAPluginInAModThatAlreadyHasARepository_RefusesIt_PointingAtDecompile_AndCommitsNothing()
    {
        WritePluginReturningItsBinarySha256("First.esp", "FirstNpc");
        await Track();
        var firstBefore = HeldBy("First.esp");
        WritePluginReturningItsBinarySha256("Second.esp", "SecondNpc");

        var result = await Track();

        Assert.Empty(result.Landed);
        Assert.Equal(
            [(Key("First.esp"), TrackRefusal.AlreadyTracked), (Key("Second.esp"), TrackRefusal.AlreadyTracked)],
            result.Refused.Select(r => (r.Plugin, r.Refusal)));
        Assert.All(result.Refused, r => Assert.Contains("decompile", r.Message, StringComparison.Ordinal));
        Assert.Equal(firstBefore, HeldBy("First.esp"));
        Assert.Empty(HeldBy("Second.esp"));
    }

    [Fact]
    public async Task Track_IntoAModWhoseRepositoryHasHistoryButNoMain_RefusesThePlugin_AndChangesNothingOfTheRepository()
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
        Assert.Equal((Key("First.esp"), TrackRefusal.AlreadyTracked), (refused.Plugin, refused.Refusal));
        Assert.Contains(_modFolder, refused.Message, StringComparison.Ordinal);
        Assert.Empty(SourceRepository.Over(TestMod.In(_modFolder), GameRelease.Fallout4).FormKeysUsed(Key("First.esp")));
        Assert.Empty(HeldBy("First.esp"));
        Assert.Equal(gitignoreBefore, File.ReadAllBytes(Path.Combine(_modFolder, ".gitignore")));
    }

    [Fact]
    public async Task Track_OfASelectionWhereOnePluginFailsItsRoundTripGate_CommitsTheOthers_AndRefusesItOnceWithItsReason()
    {
        WritePluginReturningItsBinarySha256("First.esp", "FirstNpc");
        WritePluginReturningItsBinarySha256("Second.esp", "SecondNpc");
        WritePluginReturningItsBinarySha256("Third.esp", "ThirdNpc");

        var result = await Track(new RoundTripFailsFor("Second.esp"));

        Assert.Equal([Key("First.esp"), Key("Third.esp")], result.Landed);
        var refused = Assert.Single(result.Refused);
        Assert.Equal((Key("Second.esp"), TrackRefusal.RoundTripFailed), (refused.Plugin, refused.Refusal));
        Assert.Contains("SecondNpc", refused.Message, StringComparison.Ordinal);
        Assert.NotEmpty(HeldBy("First.esp"));
        Assert.NotEmpty(HeldBy("Third.esp"));
        Assert.Empty(HeldBy("Second.esp"));
    }

    [Fact]
    public async Task Track_OfASelectionWhereEveryPluginIsRefused_CreatesNoRepository()
    {
        WritePluginReturningItsBinarySha256("Second.esp", "SecondNpc");

        var result = await Track(new RoundTripFailsFor("Second.esp"));

        Assert.Empty(result.Landed);
        Assert.Single(result.Refused);
        Assert.False(SourceRepository.IsTracked(_modFolder));
    }

    private sealed class RoundTripFailsFor(string plugin) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public override Task WriteFromTreeAsync(
            IReadOnlyList<TreeFile> files, string destinationPath, CancellationToken cancel = default) =>
            files.Any(file => file.RelativePath.StartsWith(PluginSourceRoot.For(plugin), StringComparison.Ordinal))
                ? new ForgedTreeWriteAdapter(plugin, DeserializeThenCorruptTheNpc).WriteFromTreeAsync(files, destinationPath, cancel)
                : TestAdapters.Mutagen().WriteFromTreeAsync(files, destinationPath, cancel);

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

    private Task<TrackSelectionResult> Track() => Track(TestAdapters.Mutagen());

    private Task<TrackSelectionResult> Track(IPluginAdapter adapter)
    {
        var entries = Directory.GetFiles(_modFolder, "*.esp")
            .Order(StringComparer.Ordinal)
            .Select((path, slot) => new LoadOrderEntry(Path.GetFileName(path), path, ModName, slot, Enabled: true, Winning: true))
            .ToList();
        var loadOrder = SnapshotPlugins.Snapshot(_gameDir, _gameDir, GameRelease.Fallout4, entries);
        return new TrackService(NullLogger<TrackService>.Instance, adapter)
            .TrackAsync(loadOrder, [ModName]);
    }

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);

    private IReadOnlyList<SourceDocument> HeldBy(string plugin) =>
        TreeDocuments.Of(SourceRepository.Over(TestMod.In(_modFolder), GameRelease.Fallout4), Key(plugin));
}
