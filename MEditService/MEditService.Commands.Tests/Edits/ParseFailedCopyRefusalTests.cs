using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

public sealed class ParseFailedCopyRefusalTests : IDisposable
{
    private const string UnreadablePerk = "0000EF:SKI_PlasmaAutocannon.esp";
    private const string Diagnosis = "did not have expected parameter type flag";

    private readonly ParseFailedCopyFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void CopyRecordAsOverride_OfAParseFailedRecord_IsRefusedWithItsDiagnosis_AndWritesNothing()
    {
        var result = _mod.CopyHandler.CopyAsOverride(_mod.SourcePlugin, UnreadablePerk, _mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains(Diagnosis, result.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.DestinationChangedFormKeys());
        Assert.Null(_mod.DestinationDocument(UnreadablePerk));
    }

    [Fact]
    public void CopyRecordAsNewRecord_OfAParseFailedRecord_IsRefusedWithItsDiagnosis_AndWritesNothing()
    {
        var result = _mod.CopyHandler.CopyAsNew(_mod.SourcePlugin, UnreadablePerk, _mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains(Diagnosis, result.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.DestinationChangedFormKeys());
    }

    [Fact]
    public void CopyRecordAsOverride_OfAReadablePerkFromTheSamePlugin_StillLands()
    {
        var readable = _mod.PerkTheCodecReads();

        var result = _mod.CopyHandler.CopyAsOverride(_mod.SourcePlugin, readable, _mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(_mod.DestinationDocument(readable));
    }

    [Fact]
    public void CopyRecordAsNewRecord_OfAReadablePerkFromTheSamePlugin_StillLands()
    {
        var readable = _mod.PerkTheCodecReads();

        var result = _mod.CopyHandler.CopyAsNew(_mod.SourcePlugin, readable, _mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(_mod.DestinationDocument(result.NewFormKey.Require()));
    }

    private sealed class ParseFailedCopyFixture : IDisposable
    {
        private const string SourcePluginName = "SKI_PlasmaAutocannon.esp";
        private const string SourceOrigin = "ParseFailedFixtureMod";
        private const string DestinationPluginName = "Destination.esp";
        private const string DestinationOrigin = "DestinationMod";

        private readonly ScratchDirectory _gameDirectory = new("medit-copyfail-game-");
        private readonly ScratchDirectory _sourceModFolder = new("medit-copyfail-source-");
        private readonly ScratchDirectory _destinationModFolder = new("medit-copyfail-dest-");
        private readonly string _sourcePath;

        public PluginAddress SourcePlugin { get; } = new(SourcePluginName, SourceOrigin);
        public PluginAddress DestinationPlugin { get; } = new(DestinationPluginName, DestinationOrigin);
        public CopyRecordHandler CopyHandler { get; }

        public ParseFailedCopyFixture()
        {
            var holder = new LoadOrderHolder();
            _sourcePath = Path.Combine(_sourceModFolder, SourcePluginName);
            File.Copy(Path.Combine(AppContext.BaseDirectory, "TestData", SourcePluginName), _sourcePath);

            var inputs = new List<LoadOrderEntry>();
            using (var overlay = Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName(SourcePluginName), _sourcePath), Fallout4Release.Fallout4))
            {
                foreach (var master in overlay.ModHeader.MasterReferences)
                {
                    var stubPath = Path.Combine(_gameDirectory, master.Master.FileName);
                    new Fallout4Mod(master.Master, Fallout4Release.Fallout4).WriteToBinary(stubPath);
                    inputs.Add(new LoadOrderEntry(master.Master.FileName, stubPath, "Stubs", inputs.Count, Enabled: true, Winning: true));
                }
            }
            inputs.Add(new LoadOrderEntry(SourcePluginName, _sourcePath, SourceOrigin, inputs.Count, Enabled: true, Winning: true));

            var destinationPath = Path.Combine(_destinationModFolder, DestinationPluginName);
            var destination = new Fallout4Mod(ModKey.FromFileName(DestinationPluginName), Fallout4Release.Fallout4);
            destination.Npcs.AddNew("DestinationNpc");
            destination.WriteToBinary(destinationPath);
            inputs.Add(new LoadOrderEntry(DestinationPluginName, destinationPath, DestinationOrigin, inputs.Count, Enabled: true, Winning: true));

            var loadOrder = SnapshotPlugins.Snapshot(_gameDirectory, _gameDirectory, GameRelease.Fallout4, inputs);
            new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
                .TrackModAsync(loadOrder, DestinationOrigin, SourcePreset.Edits).GetAwaiter().GetResult();

            holder.Apply(loadOrder);
            CopyHandler = TestEditService.CopyHandler(holder);
        }

        public SourceDocument? DestinationDocument(string formKey) =>
            TrackedTree.Document(_destinationModFolder, DestinationPlugin, formKey);

        public string PerkTheCodecReads()
        {
            var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
            using var overlay = Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName(SourcePluginName), _sourcePath), Fallout4Release.Fallout4);
            foreach (var perk in overlay.Perks)
            {
                try
                {
                    codec.SerializeToBytes(perk, GameRelease.Fallout4);
                }
                catch (Exception ex) when (ex is not OutOfMemoryException)
                {
                    continue;
                }
                return perk.FormKey.ToString();
            }
            throw new InvalidOperationException($"{SourcePluginName} holds no perk the codec can read.");
        }

        public IReadOnlyList<string> DestinationChangedFormKeys() => TrackedTree.ChangedFormKeys(_destinationModFolder, DestinationPlugin);

        public void Dispose()
        {
            _sourceModFolder.Dispose();
            _destinationModFolder.Dispose();
            _gameDirectory.Dispose();
        }
    }
}

public sealed class ParseFailedDialogChildCopyRefusalTests : IDisposable
{
    private readonly ContainerCopyFixture _mod = ContainerCopyFixture.CreateWithTrackedSource();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void CopyRecordAsNewRecord_OfADialogTopicWithAnUnreadableResponse_IsRefused_AndWritesNothing()
    {
        var quest = _mod.DocumentCarrying(_mod.SourcePlugin, ContainerCopyFixture.Response2EditorId);
        _mod.Overwrite(
            _mod.SourcePlugin,
            quest with
            {
                Body = quest.Body.Replace(
                    $"\"EditorID\": \"{ContainerCopyFixture.Response2EditorId}\"",
                    $"\"MajorRecordFlagsRaw\": \"notanumber\",\n\"EditorID\": \"{ContainerCopyFixture.Response2EditorId}\"",
                    StringComparison.Ordinal),
            });

        var result = _mod.CopyHandler.CopyAsNew(
            _mod.SourcePlugin, _mod.DialogTopic.ToString(), _mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains("Unable to cast", result.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.DestinationChangedFormKeys());
        Assert.Null(_mod.Document(_mod.DestinationPlugin, _mod.Quest.ToString()));
    }
}
