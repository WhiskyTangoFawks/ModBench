using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

/// <summary><c>SKI_PlasmaAutocannon.esp</c> carries exactly one record Mutagen cannot read: a PERK
/// whose entry-point parameter flags it refuses.</summary>
public sealed class ParseFailedRecordTests
{
    private const string Fixture = "SKI_PlasmaAutocannon.esp";
    private const string Origin = "ParseFailedFixtureMod";
    private const string UnreadablePerk = "0000EF:SKI_PlasmaAutocannon.esp";
    private const string Diagnosis = "did not have expected parameter type flag";

    [Fact]
    public void Reconcile_KeepsTheUnreadableRecordInTheIndexWithItsDiagnosis()
    {
        using var scratch = new Scratch(Fixture);

        var perk = Perks(scratch).Single(r => r.FormKey == UnreadablePerk);

        Assert.NotNull(perk.ParseDiagnosis);
        Assert.Contains(Diagnosis, perk.ParseDiagnosis);
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

        var readable = Perks(scratch).Where(r => r.FormKey != UnreadablePerk).ToList();

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
            .Where(kv => kv.Key != PluginHeader.RecordType)
            .Sum(kv => overlay.EnumerateMajorRecords(kv.Value.RecordType, throwIfUnknown: false).Count());

        var listed = scratch.Reads.GetRecordTypeCounts(scratch.Plugin)
            .Where(c => c.Type != PluginHeader.RecordType).Sum(c => c.Count);

        Assert.Equal(inThePlugin, listed);
    }

    [Fact]
    public void GetRecordTypeCounts_MarksOnlyTheSubtreeHoldingTheUnreadableRecord()
    {
        using var scratch = new Scratch(Fixture);

        var counts = scratch.Reads.GetRecordTypeCounts(scratch.Plugin);

        Assert.True(counts.Single(t => t.Type == "perk").HasParseFailure);
        Assert.All(counts.Where(t => t.Type != "perk"), t => Assert.False(t.HasParseFailure));
    }

    [Fact]
    public void GetPluginsWithParseFailures_NamesOnlyThePluginHoldingTheUnreadableRecord()
    {
        using var scratch = new Scratch(Fixture);

        var flagged = scratch.Reads.GetPluginsWithParseFailures();

        Assert.Equal([ColumnKey.Of(Fixture, Origin)], flagged.Order(StringComparer.Ordinal));
        // The stub masters really are indexed beside it, so "only" has something to exclude.
        Assert.True(scratch.Reads.OpenedCopies.Count > 1);
    }

    [Fact]
    public void GetOverrideStack_ReadsTheUnreadableRecordBackFromItsStoredBody()
    {
        using var scratch = new Scratch(Fixture);

        var stack = scratch.Reads.GetOverrideStack(UnreadablePerk);

        Assert.NotNull(stack);
        var document = Assert.Single(stack.Entries).Effective;
        Assert.Equal(UnreadablePerk, document.FormKey);
        Assert.Equal("T6M_QuickReload_ReloadVATs", document.EditorId);
    }

    // The record editor renders the column read-only from this member alone, so the document a
    // caller reads has to carry the diagnosis rather than only the tree's listings.
    [Fact]
    public void GetOverrideStack_CarriesTheDiagnosisOnTheUnreadableRecordsDocument()
    {
        using var scratch = new Scratch(Fixture);

        var document = Assert.Single(scratch.Reads.GetOverrideStack(UnreadablePerk).Require().Entries).Effective;

        Assert.NotNull(document.ParseDiagnosis);
        Assert.Contains(Diagnosis, document.ParseDiagnosis);
    }

    [Fact]
    public void GetOverrideStack_LeavesAReadableRecordsDocumentWithoutADiagnosis()
    {
        using var scratch = new Scratch(Fixture);
        var readable = Perks(scratch).First(r => r.FormKey != UnreadablePerk);

        var document = Assert.Single(scratch.Reads.GetOverrideStack(readable.FormKey).Require().Entries).Effective;

        Assert.Null(document.ParseDiagnosis);
    }

    // Corrupting a major record's signature inside its GRUP makes Mutagen's location scan throw
    // before it yields anything of that type, so nothing of that type is reachable.
    [Fact]
    public void Reconcile_OfAPluginWhoseGroupCannotBeEnumerated_KeepsItsOtherRecordTypes()
    {
        using var scratch = new Scratch(CorruptGroupFixture.Build(), CorruptGroupFixture.PluginName);

        var counts = scratch.Reads.GetRecordTypeCounts(scratch.Plugin);

        Assert.Equal(1, counts.Single(t => t.Type == "weap").Count);
        Assert.DoesNotContain(scratch.Index.Status.Failures, f => f.Name == CorruptGroupFixture.PluginName);
    }

    [Fact]
    public void Reconcile_OfAPluginWhoseGroupCannotBeEnumerated_MarksThatRecordTypeAndItsPlugin()
    {
        using var scratch = new Scratch(CorruptGroupFixture.Build(), CorruptGroupFixture.PluginName);

        var counts = scratch.Reads.GetRecordTypeCounts(scratch.Plugin);

        Assert.True(counts.Single(t => t.Type == "npc_").HasParseFailure);
        Assert.False(counts.Single(t => t.Type == "weap").HasParseFailure);
        Assert.Contains(
            ColumnKey.Of(CorruptGroupFixture.PluginName, Origin), scratch.Reads.GetPluginsWithParseFailures());
    }

    [Fact]
    public void Reconcile_OfAPluginThatCannotBeOpenedAtAllStillReportsAPluginLoadFailure()
    {
        using var scratch = new Scratch(Fixture, corruptWholeFile: true);

        Assert.Contains(scratch.Index.Status.Failures, f => f.Name == Fixture);
    }

    private static IReadOnlyList<RecordSummary> Perks(Scratch scratch) =>
        scratch.Reads.Search(new RecordQuery(
            RecordTypes: ["perk"], Plugin: scratch.Plugin.Name, Origin: scratch.Plugin.Origin,
            Search: null, Limit: 1000, Offset: 0)).Items;

    // One NPC whose signature inside the NPC_ GRUP is mangled, plus one readable WEAP, so
    // "the rest of the plugin still indexes" has something to be true of.
    private static class CorruptGroupFixture
    {
        internal const string PluginName = "CorruptGroup.esp";

        internal static string Build()
        {
            var path = Path.Combine(Directory.CreateTempSubdirectory("medit-corruptgroup-").FullName, PluginName);
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("TheNpc");
            mod.Weapons.AddNew("TheWeapon");
            mod.WriteToBinary(path);

            var bytes = File.ReadAllBytes(path);
            // The first occurrence is the GRUP header's contained-type field; the second is the
            // record itself, and only that one is mangled.
            var occurrences = new List<int>();
            for (var i = 0; i + 4 <= bytes.Length; i++)
            {
                if (bytes[i] == 'N' && bytes[i + 1] == 'P' && bytes[i + 2] == 'C' && bytes[i + 3] == '_')
                    occurrences.Add(i);
            }
            bytes[occurrences[1]] = (byte)'X';
            File.WriteAllBytes(path, bytes);
            return path;
        }
    }

    // Stub masters come from the fixture's own declared list: the Index needs the names present,
    // not their content.
    private sealed class Scratch : IDisposable
    {
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-parsefail-game-").FullName;
        private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-parsefail-mod-").FullName;

        public IndexProjector Index { get; }
        public IRecordReads Reads => Index.Projected();
        public PluginCopyKey Plugin { get; }
        public string PluginPath { get; }

        public Scratch(string fixtureFileName, bool corruptWholeFile = false)
            : this(Path.Combine(AppContext.BaseDirectory, "TestData", fixtureFileName), fixtureFileName, corruptWholeFile)
        {
        }

        public Scratch(string sourcePath, string fixtureFileName, bool corruptWholeFile = false)
        {
            Plugin = new PluginCopyKey(fixtureFileName, Origin);
            var pluginPath = PluginPath = Path.Combine(_modFolder, fixtureFileName);
            File.Copy(sourcePath, pluginPath);

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

            Index = Indexes.Reconciled(_gameDirectory, inputs);
        }

        public void Dispose()
        {
            Index.Dispose();
            try { Directory.Delete(_modFolder, recursive: true); } catch (IOException) { }
            try { Directory.Delete(_gameDirectory, recursive: true); } catch (IOException) { }
        }
    }
}
