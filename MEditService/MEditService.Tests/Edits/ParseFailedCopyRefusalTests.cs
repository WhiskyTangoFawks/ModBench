using System.Text;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.PluginAdapter;
using MEditService.LoadOrder;
using MEditService.Codec.Serialization;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>A record the codec cannot read would land as a stub of its FormKey and EditorID rather
/// than the record. Both copies refuse it with the reader's own diagnosis.</summary>
public sealed class ParseFailedCopyRefusalTests : IDisposable
{
    private const string UnreadablePerk = "0000EF:SKI_PlasmaAutocannon.esp";
    private const string Diagnosis = "did not have expected parameter type flag";

    private readonly ParseFailedCopyFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void CopyRecordAsOverride_OfAParseFailedRecord_IsRefusedWithItsDiagnosis_AndWritesNothing()
    {
        var result = _mod.CopyAsOverrideHandler.CopyRecordAsOverride(_mod.SourcePlugin, UnreadablePerk, _mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains(Diagnosis, result.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.DestinationGitStatus());
        Assert.Null(_mod.DestinationDocument(UnreadablePerk));
    }

    [Fact]
    public void CopyRecordAsNewRecord_OfAParseFailedRecord_IsRefusedWithItsDiagnosis_AndWritesNothing()
    {
        var result = _mod.CopyAsNewHandler.CopyRecordAsNewRecord(_mod.SourcePlugin, UnreadablePerk, _mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains(Diagnosis, result.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.DestinationGitStatus());
    }

    [Fact]
    public void CopyRecordAsOverride_OfAReadablePerkFromTheSamePlugin_StillLands()
    {
        var readable = _mod.PerkTheCodecReads();

        var result = _mod.CopyAsOverrideHandler.CopyRecordAsOverride(_mod.SourcePlugin, readable, _mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(_mod.DestinationDocument(readable));
    }

    [Fact]
    public void CopyRecordAsNewRecord_OfAReadablePerkFromTheSamePlugin_StillLands()
    {
        var readable = _mod.PerkTheCodecReads();

        var result = _mod.CopyAsNewHandler.CopyRecordAsNewRecord(_mod.SourcePlugin, readable, _mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(_mod.DestinationDocument(result.NewFormKey!));
    }

    // The source stays untracked, so the copy reads it through the Plugin adapter — the one door a
    // record with no source text has.
    private sealed class ParseFailedCopyFixture : IDisposable
    {
        private const string SourcePluginName = "SKI_PlasmaAutocannon.esp";
        private const string SourceOrigin = "ParseFailedFixtureMod";
        private const string DestinationPluginName = "Destination.esp";
        private const string DestinationOrigin = "DestinationMod";

        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-copyfail-game-").FullName;
        private readonly string _sourceModFolder = Directory.CreateTempSubdirectory("medit-copyfail-source-").FullName;
        private readonly string _destinationModFolder = Directory.CreateTempSubdirectory("medit-copyfail-dest-").FullName;
        private readonly string _sourcePath;

        public PluginKey SourcePlugin { get; } = new(SourcePluginName, SourceOrigin);
        public PluginKey DestinationPlugin { get; } = new(DestinationPluginName, DestinationOrigin);
        public CopyRecordAsOverrideHandler CopyAsOverrideHandler { get; }
        public CopyRecordAsNewRecordHandler CopyAsNewHandler { get; }

        public ParseFailedCopyFixture()
        {
            var holder = new LoadOrderHolder();
            _sourcePath = Path.Combine(_sourceModFolder, SourcePluginName);
            File.Copy(Path.Combine(AppContext.BaseDirectory, "TestData", SourcePluginName), _sourcePath);

            // The reader needs the fixture's declared masters present, not their content.
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

            // Last, so the copy is never an underride of the plugin it copies from.
            var destinationPath = Path.Combine(_destinationModFolder, DestinationPluginName);
            var destination = new Fallout4Mod(ModKey.FromFileName(DestinationPluginName), Fallout4Release.Fallout4);
            destination.Npcs.AddNew("DestinationNpc");
            destination.WriteToBinary(destinationPath);
            inputs.Add(new LoadOrderEntry(DestinationPluginName, destinationPath, DestinationOrigin, inputs.Count, Enabled: true, Winning: true));

            var loadOrder = new LoadOrderSnapshot(_gameDirectory, _gameDirectory, GameRelease.Fallout4, SnapshotCopies.Of(inputs));
            new TrackService(NullLogger<TrackService>.Instance, MutagenPluginAdapter.Instance)
                .TrackAsync(loadOrder, [DestinationPlugin], DestinationOrigin, SourcePreset.Edits).GetAwaiter().GetResult();

            holder.Apply(loadOrder);
            CopyAsOverrideHandler = TestEditService.CopyAsOverrideHandler(holder);
            CopyAsNewHandler = TestEditService.CopyAsNewHandler(holder);
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
                    codec.SerializeToBytesAsync(perk, GameRelease.Fallout4).GetAwaiter().GetResult();
                }
                catch (Exception)
                {
                    continue;
                }
                return perk.FormKey.ToString();
            }
            throw new InvalidOperationException($"{SourcePluginName} holds no perk the codec can read.");
        }

        public IReadOnlyList<string> DestinationGitStatus() => TrackedTree.GitStatus(_destinationModFolder);

        public void Dispose()
        {
            TryDelete(_sourceModFolder);
            TryDelete(_destinationModFolder);
            TryDelete(_gameDirectory);
        }

        // A tracked mod folder's .git objects are read-only on some filesystems, and a test failing
        // on cleanup would mask the assertion that already ran.
        private static void TryDelete(string path)
        {
            try { Directory.Delete(path, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
            catch (UnauthorizedAccessException) { /* ditto */ }
        }
    }
}

/// <summary>A dialog topic's responses are inside its own document, so a response the codec cannot
/// read makes the topic unreadable too: the copy refuses before the quest chain is minted.</summary>
public sealed class ParseFailedDialogChildCopyRefusalTests : IDisposable
{
    private readonly ContainerCopyFixture _mod = ContainerCopyFixture.CreateWithTrackedSource();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void CopyRecordAsNewRecord_OfADialogTopicWithAnUnreadableResponse_IsRefused_AndWritesNothing()
    {
        var questFile = _mod.SourceFileContaining(_mod.SourcePlugin, ContainerCopyFixture.Response2EditorId);
        File.WriteAllText(
            questFile,
            File.ReadAllText(questFile).Replace(
                $"\"EditorID\": \"{ContainerCopyFixture.Response2EditorId}\"",
                $"\"MajorRecordFlagsRaw\": \"notanumber\",\n\"EditorID\": \"{ContainerCopyFixture.Response2EditorId}\"",
                StringComparison.Ordinal));

        var result = _mod.CopyAsNewHandler.CopyRecordAsNewRecord(
            _mod.SourcePlugin, _mod.DialogTopic.ToString(), _mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        // The reader's own words, not ours: the codec is the only thing that can say why.
        Assert.Contains("Unable to cast", result.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.DestinationGitStatus());
        // The auto-created parent quest override is the first thing the copy would land.
        Assert.Null(_mod.Document(_mod.DestinationPlugin, _mod.Quest.ToString()));
    }
}
