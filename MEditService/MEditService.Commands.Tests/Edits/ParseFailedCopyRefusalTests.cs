using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

public sealed class ParseFailedCopyRefusalTests : IDisposable
{
    private static readonly string UnreadablePerk = MisshapedPerkPlugin.FormKey;
    private const string Diagnosis = "did not have expected parameter type flag";

    private readonly ParseFailedCopyFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void CopyRecordAsOverride_OfAParseFailedRecord_IsRefusedWithItsDiagnosis_AndWritesNothing()
    {
        var result = _mod.CopyHandler.CopySync([new RecordAt(_mod.SourcePlugin, UnreadablePerk)], CopyMode.Override, [_mod.DestinationPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.RecordParseFailed, refused.Refusal);
        Assert.Contains(
            $"{UnreadablePerk} ({MisshapedPerkPlugin.EditorId}) — {PluginDiagnosis.UnknownClass}:", refused.Message, StringComparison.Ordinal);
        Assert.Contains(Diagnosis, refused.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.ChangedFormKeys(_mod.DestinationPlugin));
        Assert.Null(_mod.Document(_mod.DestinationPlugin, UnreadablePerk));
    }

    [Fact]
    public void CopyRecordAsNewRecord_OfAParseFailedRecord_IsRefusedWithItsDiagnosis_AndWritesNothing()
    {
        var result = _mod.CopyHandler.CopySync([new RecordAt(_mod.SourcePlugin, UnreadablePerk)], CopyMode.New, [_mod.DestinationPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.RecordParseFailed, refused.Refusal);
        Assert.Contains(Diagnosis, refused.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.ChangedFormKeys(_mod.DestinationPlugin));
    }

    [Fact]
    public void CopyRecordAsOverride_OfAReadablePerkFromTheSamePlugin_StillLands()
    {
        var readable = MisshapedPerkPlugin.ReadableFormKey;

        var result = _mod.CopyHandler.CopySync([new RecordAt(_mod.SourcePlugin, readable)], CopyMode.Override, [_mod.DestinationPlugin], replace: false);

        result.OnlyLanded();
        Assert.NotNull(_mod.Document(_mod.DestinationPlugin, readable));
        Assert.Equal([readable], _mod.ChangedFormKeys(_mod.DestinationPlugin));
    }

    [Fact]
    public void CopyRecordAsNewRecord_OfAReadablePerkFromTheSamePlugin_StillLands()
    {
        var readable = MisshapedPerkPlugin.ReadableFormKey;

        var result = _mod.CopyHandler.CopySync([new RecordAt(_mod.SourcePlugin, readable)], CopyMode.New, [_mod.DestinationPlugin], replace: false);

        var newFormKey = result.OnlyLanded().Require();
        Assert.NotNull(_mod.Document(_mod.DestinationPlugin, newFormKey));
        Assert.Equal(["000000:Destination.esp", newFormKey], _mod.ChangedFormKeys(_mod.DestinationPlugin));
    }

    private sealed class ParseFailedCopyFixture : IDisposable, ITrackedPlugins
    {
        private const string SourcePluginName = MisshapedPerkPlugin.FileName;
        private const string SourceOrigin = "ParseFailedFixtureMod";
        private const string DestinationPluginName = "Destination.esp";
        private const string DestinationOrigin = "DestinationMod";

        private readonly ScratchDirectory _gameDirectory = new("medit-copyfail-game-");
        private readonly ScratchDirectory _sourceModFolder = new("medit-copyfail-source-");
        private readonly ScratchDirectory _destinationModFolder = new("medit-copyfail-dest-");
        private readonly string _sourcePath;

        public PluginAddress SourcePlugin { get; } = new(SourcePluginName, SourceOrigin);
        public PluginAddress DestinationPlugin { get; } = new(DestinationPluginName, DestinationOrigin);
        public CopyRecordChangesHandler CopyHandler { get; }

        public ParseFailedCopyFixture()
        {
            var holder = new LoadOrderHolder();
            _sourcePath = Path.Combine(_sourceModFolder, SourcePluginName);
            File.WriteAllBytes(_sourcePath, MisshapedPerkPlugin.Plugin.Bytes);

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
            TrackEveryPluginOf.ModAsync(loadOrder, DestinationOrigin).GetAwaiter().GetResult();

            holder.Apply(loadOrder);
            CopyHandler = TestEditService.CopyHandler(holder);
        }

        public string ModFolderOf(PluginAddress plugin) => plugin == DestinationPlugin ? _destinationModFolder : _sourceModFolder;

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

        var result = _mod.CopyHandler.CopySync([new RecordAt(_mod.SourcePlugin, _mod.DialogTopic.ToString())], CopyMode.New, [_mod.DestinationPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.RecordParseFailed, refused.Refusal);
        Assert.Contains("Unable to cast", refused.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.ChangedFormKeys(_mod.DestinationPlugin));
        Assert.Null(_mod.Document(_mod.DestinationPlugin, _mod.Quest.ToString()));
    }
}
