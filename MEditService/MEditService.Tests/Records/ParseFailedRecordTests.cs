using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary><c>SKI_PlasmaAutocannon.esp</c> carries exactly one record Mutagen cannot read: a PERK
/// whose entry-point parameter flags it refuses.</summary>
public sealed class ParseFailedRecordTests
{
    private const string Fixture = "SKI_PlasmaAutocannon.esp";
    private const string Origin = "ParseFailedFixtureMod";
    private const string UnreadablePerk = "0000EF:SKI_PlasmaAutocannon.esp";

    [Fact]
    public void Reconcile_KeepsTheUnreadableRecordInTheIndexWithItsDiagnosis()
    {
        using var scratch = new Scratch(Fixture);

        var perk = scratch.Reads
            .Search(new RecordQuery(RecordTypes: ["perk"], Plugin: scratch.Plugin, Search: null, Limit: 100, Offset: 0))
            .Items.Single(r => r.FormKey == UnreadablePerk);

        Assert.NotNull(perk.ParseDiagnosis);
        Assert.Contains("did not have expected parameter type flag", perk.ParseDiagnosis);
    }

    [Fact]
    public void Reconcile_IndexesTheRestOfThePluginAroundTheUnreadableRecord()
    {
        using var scratch = new Scratch(Fixture);

        var counts = scratch.Reads.GetRecordTypeCounts(scratch.Plugin);

        Assert.True(counts.Sum(c => c.Count) > 1,
            "the plugin's readable records must still index; a single unreadable record is not a plugin-wide failure");
    }

    [Fact]
    public void Reconcile_LeavesEveryReadableRecordWithoutADiagnosis()
    {
        using var scratch = new Scratch(Fixture);

        var readable = scratch.Reads
            .Search(new RecordQuery(RecordTypes: ["perk"], Plugin: scratch.Plugin, Search: null, Limit: 1000, Offset: 0))
            .Items.Where(r => r.FormKey != UnreadablePerk);

        Assert.NotEmpty(readable);
        Assert.All(readable, r => Assert.Null(r.ParseDiagnosis));
    }

    [Fact]
    public void Search_ListsEveryMajorRecordThePluginHolds()
    {
        using var scratch = new Scratch(Fixture);
        using var overlay = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName(Fixture), scratch.PluginPath), Fallout4Release.Fallout4);
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        var inThePlugin = schemas
            .Where(kv => kv.Key != HeaderIndexer.RecordType)
            .Sum(kv => overlay.EnumerateMajorRecords(kv.Value.RecordType, throwIfUnknown: false).Count());

        var listed = scratch.Reads.GetRecordTypeCounts(scratch.Plugin)
            .Where(c => c.Type != HeaderIndexer.RecordType).Sum(c => c.Count);

        Assert.Equal(inThePlugin, listed);
    }

    [Fact]
    public void GetPluginRecordTypes_MarksOnlyTheSubtreeHoldingTheUnreadableRecord()
    {
        using var scratch = new Scratch(Fixture);

        var types = scratch.Query.GetPluginRecordTypes(Fixture, Origin);

        Assert.True(types.Single(t => t.Type == "perk").HasParseFailure);
        Assert.All(types.Where(t => t.Type != "perk"), t => Assert.False(t.HasParseFailure));
    }

    [Fact]
    public void GetPlugins_MarksOnlyThePluginHoldingTheUnreadableRecord()
    {
        using var scratch = new Scratch(Fixture);

        var plugins = scratch.Query.GetPlugins();

        Assert.True(plugins.Single(p => p.Name == Fixture).HasParseFailure);
        Assert.All(plugins.Where(p => p.Name != Fixture), p => Assert.False(p.HasParseFailure));
    }

    [Fact]
    public void Reconcile_OfAPluginThatCannotBeOpenedAtAllStillReportsAPluginLoadFailure()
    {
        using var scratch = new Scratch(Fixture, corruptWholeFile: true);

        Assert.Contains(scratch.Mirror.LoadOrder!.Failures, f => f.Name == Fixture);
    }

    // Stub masters come from the fixture's own declared list: the mirror needs the names present,
    // not their content.
    private sealed class Scratch : IDisposable
    {
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-parsefail-game-").FullName;
        private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-parsefail-mod-").FullName;

        public LoadOrderMirror Mirror { get; }
        public IRecordReads Reads => Mirror.Reads!;
        public PluginKey Plugin { get; }
        public IRecordQueryService Query { get; }
        public string PluginPath { get; }

        public Scratch(string fixtureFileName, bool corruptWholeFile = false)
        {
            Plugin = new PluginKey(fixtureFileName, Origin);
            var pluginPath = PluginPath = Path.Combine(_modFolder, fixtureFileName);
            File.Copy(Path.Combine(AppContext.BaseDirectory, "TestData", fixtureFileName), pluginPath);

            var inputs = new List<LoadOrderEntry>();
            using (var overlay = Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName(fixtureFileName), pluginPath), Fallout4Release.Fallout4))
            {
                foreach (var master in overlay.ModHeader.MasterReferences)
                {
                    var stubPath = Path.Combine(_gameDirectory, master.Master.FileName);
                    new Fallout4Mod(master.Master, Fallout4Release.Fallout4).WriteToBinary(stubPath);
                    inputs.Add(new LoadOrderEntry(master.Master.FileName, stubPath, "Stubs", inputs.Count, Enabled: true, Winning: true));
                }
            }
            inputs.Add(new LoadOrderEntry(fixtureFileName, pluginPath, Origin, inputs.Count, Enabled: true, Winning: true));

            // Truncated below a TES4 header: no record identity exists to hang a status on.
            if (corruptWholeFile) File.WriteAllBytes(pluginPath, [0x54, 0x45, 0x53, 0x34, 0xFF]);

            Mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)Mirror).Reconcile(_gameDirectory, inputs, GameRelease.Fallout4);
            Query = new RecordQueryService(Mirror, SharedSchemaReflector.Instance, new ConflictClassifier());
        }

        public void Dispose()
        {
            Mirror.Dispose();
            try { Directory.Delete(_modFolder, recursive: true); } catch (IOException) { }
            try { Directory.Delete(_gameDirectory, recursive: true); } catch (IOException) { }
        }
    }
}
