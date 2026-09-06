using DuckDB.NET.Data;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>A record Mutagen could not read is indexed as a stub of its FormKey and EditorID, so
/// copying it would land that stub as a real record. Both copies refuse it with the
/// diagnosis.</summary>
public sealed class ParseFailedCopyRefusalTests : IDisposable
{
    private const string UnreadablePerk = "0000EF:SKI_PlasmaAutocannon.esp";
    private const string Diagnosis = "did not have expected parameter type flag";

    private readonly ParseFailedCopyFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void CopyRecordAsOverride_OfAParseFailedRecord_IsRefusedWithItsDiagnosis_AndWritesNothing()
    {
        var result = _mod.Service.CopyRecordAsOverride(_mod.SourcePlugin, UnreadablePerk, _mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains(Diagnosis, result.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.DestinationGitStatus());
        Assert.Null(_mod.Reads.GetDocument(UnreadablePerk, _mod.DestinationPlugin));
    }

    [Fact]
    public void CopyRecordAsNewRecord_OfAParseFailedRecord_IsRefusedWithItsDiagnosis_AndWritesNothing()
    {
        var before = _mod.DestinationRecordCount();

        var result = _mod.Service.CopyRecordAsNewRecord(_mod.SourcePlugin, UnreadablePerk, _mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains(Diagnosis, result.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.DestinationGitStatus());
        Assert.Equal(before, _mod.DestinationRecordCount());
    }

    [Fact]
    public void CopyRecordAsOverride_OfAReadablePerkFromTheSamePlugin_StillLands()
    {
        var readable = _mod.ReadablePerk();

        var result = _mod.Service.CopyRecordAsOverride(_mod.SourcePlugin, readable, _mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(_mod.Reads.GetDocument(readable, _mod.DestinationPlugin));
    }

    [Fact]
    public void CopyRecordAsNewRecord_OfAReadablePerkFromTheSamePlugin_StillLands()
    {
        var readable = _mod.ReadablePerk();

        var result = _mod.Service.CopyRecordAsNewRecord(_mod.SourcePlugin, readable, _mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(_mod.Reads.GetDocument(result.NewFormKey!, _mod.DestinationPlugin));
    }

    // The source stays untracked, so the indexed stub really is the only representation the copy
    // can reach.
    private sealed class ParseFailedCopyFixture : IDisposable
    {
        private const string SourcePluginName = "SKI_PlasmaAutocannon.esp";
        private const string SourceOrigin = "ParseFailedFixtureMod";
        private const string DestinationPluginName = "Destination.esp";
        private const string DestinationOrigin = "DestinationMod";

        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-copyfail-game-").FullName;
        private readonly string _sourceModFolder = Directory.CreateTempSubdirectory("medit-copyfail-source-").FullName;
        private readonly string _destinationModFolder = Directory.CreateTempSubdirectory("medit-copyfail-dest-").FullName;
        private readonly LoadOrderMirror _mirror;

        public PluginKey SourcePlugin { get; } = new(SourcePluginName, SourceOrigin);
        public PluginKey DestinationPlugin { get; } = new(DestinationPluginName, DestinationOrigin);
        public RecordEditService Service { get; }
        public IRecordReads Reads => _mirror.Reads!;

        public ParseFailedCopyFixture()
        {
            var sourcePath = Path.Combine(_sourceModFolder, SourcePluginName);
            File.Copy(Path.Combine(AppContext.BaseDirectory, "TestData", SourcePluginName), sourcePath);

            // The mirror needs the fixture's declared masters present, not their content.
            var inputs = new List<LoadOrderEntry>();
            using (var overlay = Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName(SourcePluginName), sourcePath), Fallout4Release.Fallout4))
            {
                foreach (var master in overlay.ModHeader.MasterReferences)
                {
                    var stubPath = Path.Combine(_gameDirectory, master.Master.FileName);
                    new Fallout4Mod(master.Master, Fallout4Release.Fallout4).WriteToBinary(stubPath);
                    inputs.Add(new LoadOrderEntry(master.Master.FileName, stubPath, "Stubs", inputs.Count, Enabled: true, Winning: true));
                }
            }
            inputs.Add(new LoadOrderEntry(SourcePluginName, sourcePath, SourceOrigin, inputs.Count, Enabled: true, Winning: true));

            // Last, so the copy is never an underride of the plugin it copies from.
            var destinationPath = Path.Combine(_destinationModFolder, DestinationPluginName);
            var destination = new Fallout4Mod(ModKey.FromFileName(DestinationPluginName), Fallout4Release.Fallout4);
            destination.Npcs.AddNew("DestinationNpc");
            destination.WriteToBinary(destinationPath);
            inputs.Add(new LoadOrderEntry(DestinationPluginName, destinationPath, DestinationOrigin, inputs.Count, Enabled: true, Winning: true));

            _mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)_mirror).Reconcile(_gameDirectory, inputs, GameRelease.Fallout4);
            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(_mirror.LoadOrder!, DestinationOrigin, SourcePreset.Edits).GetAwaiter().GetResult();

            Service = new RecordEditService(_mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);
        }

        public string ReadablePerk() =>
            Reads.Search(new RecordQuery(RecordTypes: ["perk"], Plugin: SourcePlugin, Search: null, Limit: 1000, Offset: 0))
                .Items.First(r => r.ParseDiagnosis is null).FormKey;

        public int DestinationRecordCount() =>
            Reads.GetRecordTypeCounts(DestinationPlugin).Sum(c => c.Count);

        public IReadOnlyList<string> DestinationGitStatus() =>
            GitCli.Run(Path.Combine(_destinationModFolder, ".git"), _destinationModFolder, "status", "--porcelain")
                .Split('\n', StringSplitOptions.RemoveEmptyEntries);

        public void Dispose()
        {
            _mirror.Dispose();
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

/// <summary>A dialog topic copies its responses as new records too, so an unreadable response is
/// refused with the topic it belongs to, before the topic or any sibling is written.</summary>
public sealed class ParseFailedDialogChildCopyRefusalTests : IDisposable
{
    private const string Diagnosis = "the response subrecord was cut short";

    private readonly ContainerCopyFixture _mod = ContainerCopyFixture.Create();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void CopyRecordAsNewRecord_OfADialogTopicWithAParseFailedResponse_IsRefused_AndWritesNothing()
    {
        using (var cmd = ((DuckDbRecordIndex)_mod.Mirror.Index!).Connection.CreateCommand())
        {
            cmd.CommandText = "UPDATE mirror.records SET parse_diagnosis = $1 WHERE form_key = $2";
            cmd.Parameters.Add(new DuckDBParameter { Value = Diagnosis });
            cmd.Parameters.Add(new DuckDBParameter { Value = _mod.Response2.ToString() });
            cmd.ExecuteNonQuery();
        }
        var service = new RecordEditService(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

        var result = service.CopyRecordAsNewRecord(_mod.SourcePlugin, _mod.DialogTopic.ToString(), _mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains(_mod.Response2.ToString(), result.Message, StringComparison.Ordinal);
        Assert.Contains(Diagnosis, result.Message, StringComparison.Ordinal);
        Assert.Empty(GitCli
            .Run(Path.Combine(_mod.DestinationModFolder, ".git"), _mod.DestinationModFolder, "status", "--porcelain")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries));
        // The auto-created parent quest override is the first thing the copy would land.
        Assert.Null(_mod.Mirror.Reads!.GetDocument(_mod.Quest.ToString(), _mod.DestinationPlugin));
    }
}
