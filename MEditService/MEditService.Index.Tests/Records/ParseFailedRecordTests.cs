using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

public sealed class ParseFailedRecordTests
{
    private const string Origin = "ParseFailedFixtureMod";
    private static readonly string PerkWhoseEntryPointParameterFlagsMutagenRefuses = MisshapedPerkPlugin.FormKey;
    private const string Diagnosis = "did not have expected parameter type flag";
    private const string DeletedNpcPluginName = "DeletedNpc.esp";
    private const string DeletedNpc = "000800:DeletedNpc.esp";

    [Fact]
    public void Reconcile_KeepsTheUnreadableRecordInTheIndexWithItsDiagnosis()
    {
        using var scratch = Scratch.Misshaped();

        var perk = Perks(scratch).Single(r => r.FormKey == PerkWhoseEntryPointParameterFlagsMutagenRefuses);

        Assert.NotNull(perk.ParseDiagnosis);
        Assert.Contains(Diagnosis, perk.ParseDiagnosis);
    }

    [Fact]
    public void Reconcile_IndexesTheRestOfThePluginAroundTheUnreadableRecord()
    {
        using var scratch = Scratch.Misshaped();

        var counts = scratch.Index.Records.GetPluginRecordTypes(scratch.Plugin);

        Assert.True(counts.Sum(c => c.Count) > 1,
            "the plugin's readable records must still index; a single unreadable record is not a plugin-wide failure");
    }

    [Fact]
    public void Reconcile_LeavesEveryReadableRecordWithoutADiagnosis()
    {
        using var scratch = Scratch.Misshaped();

        var readable = Perks(scratch).Where(r => r.FormKey != PerkWhoseEntryPointParameterFlagsMutagenRefuses).ToList();

        Assert.NotEmpty(readable);
        Assert.All(readable, r => Assert.Null(r.ParseDiagnosis));
    }

    [Fact]
    public void Search_ListsEveryMajorRecordThePluginHolds()
    {
        using var scratch = Scratch.Misshaped();
        using var overlay = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName(MisshapedPerkPlugin.FileName), scratch.PluginPath), Fallout4Release.Fallout4);
        var inThePlugin = overlay.EnumerateMajorRecords().Count();

        var listed = scratch.Index.Records.GetPluginRecordTypes(scratch.Plugin).Sum(c => c.Count);

        Assert.Equal(inThePlugin, listed);
    }

    [Fact]
    public void TheRecordTypeCounts_MarkOnlyTheSubtreeHoldingTheUnreadableRecord()
    {
        using var scratch = Scratch.Misshaped();

        var counts = scratch.Index.Records.GetPluginRecordTypes(scratch.Plugin);

        Assert.True(counts.Single(t => t.Type == "perk").HasParseFailure);
        Assert.All(counts.Where(t => t.Type != "perk"), t => Assert.False(t.HasParseFailure));
    }

    [Fact]
    public void OnlyThePluginHoldingTheUnreadableRecord_HasAParseFailure()
    {
        using var scratch = Scratch.Misshaped();

        var plugins = scratch.Index.Records.GetPlugins();

        Assert.Equal([scratch.Plugin], plugins.Where(p => p.HasParseFailure).Select(p => p.Plugin.Key));
        var stubMastersIndexedBesideItSoOnlyHasSomethingToExclude = plugins.Count;
        Assert.True(stubMastersIndexedBesideItSoOnlyHasSomethingToExclude > 1);
    }

    [Fact]
    public void AParseFailure_IsNamedForAPluginThatIsNotActive()
    {
        using var scratch = Scratch.Misshaped(active: false);

        Assert.True(scratch.Index.PluginRowOf(scratch.Plugin)?.HasParseFailure);
    }

    [Fact]
    public void TheCompare_ReadsTheUnreadableRecordBackFromItsStoredBody()
    {
        using var scratch = Scratch.Misshaped();

        var document = Assert.Single(scratch.Index.StackOf(PerkWhoseEntryPointParameterFlagsMutagenRefuses));
        Assert.Equal(PerkWhoseEntryPointParameterFlagsMutagenRefuses, document.FormKey);
        Assert.Equal(MisshapedPerkPlugin.EditorId, document.EditorId);
    }

    [Fact]
    public void TheCompare_CarriesTheDiagnosisOnTheUnreadableRecordsDocument()
    {
        using var scratch = Scratch.Misshaped();

        var document = Assert.Single(scratch.Index.StackOf(PerkWhoseEntryPointParameterFlagsMutagenRefuses));

        Assert.NotNull(document.ParseDiagnosis);
        Assert.Contains(Diagnosis, document.ParseDiagnosis);
    }

    [Fact]
    public void TheCompare_LeavesAReadableRecordsDocumentWithoutADiagnosis()
    {
        using var scratch = Scratch.Misshaped();
        var readable = Perks(scratch).First(r => r.FormKey != PerkWhoseEntryPointParameterFlagsMutagenRefuses);

        var document = Assert.Single(scratch.Index.StackOf(readable.FormKey));

        Assert.Null(document.ParseDiagnosis);
    }

    [Fact]
    public void Reconcile_OfAPluginWhoseGroupCannotBeEnumerated_KeepsItsOtherRecordTypes()
    {
        using var sources = new ScratchDirectory("medit-parsefail-source-");
        using var scratch = new Scratch(CorruptGroupFixture.BuildWithANpcSignatureMangledSoMutagensLocationScanThrowsBeforeYieldingAnyNpc(sources), CorruptGroupFixture.PluginName);

        var counts = scratch.Index.Records.GetPluginRecordTypes(scratch.Plugin);

        Assert.Equal(1, counts.Single(t => t.Type == "weap").Count);
        Assert.DoesNotContain(scratch.Index.Status.Failures, f => f.Name == CorruptGroupFixture.PluginName);
    }

    [Fact]
    public void Reconcile_OfAPluginWhoseGroupCannotBeEnumerated_MarksThatRecordTypeAndItsPlugin()
    {
        using var sources = new ScratchDirectory("medit-parsefail-source-");
        using var scratch = new Scratch(CorruptGroupFixture.BuildWithANpcSignatureMangledSoMutagensLocationScanThrowsBeforeYieldingAnyNpc(sources), CorruptGroupFixture.PluginName);

        var counts = scratch.Index.Records.GetPluginRecordTypes(scratch.Plugin);

        Assert.True(counts.Single(t => t.Type == "npc_").HasParseFailure);
        Assert.False(counts.Single(t => t.Type == "weap").HasParseFailure);
        Assert.True(scratch.Index.PluginRowOf(scratch.Plugin)?.HasParseFailure);
    }

    [Fact]
    public void Reconcile_IndexesADeletedRecordWhoseFieldsAreAbsent_AsDeleted_NotParseFailed()
    {
        using var sources = new ScratchDirectory("medit-parsefail-source-");
        using var scratch = new Scratch(Scratch.DeletedNpcPlugin(sources, (path, npc) => DeletedNpcPlugin.WriteEmpty(path, npc)), DeletedNpcPluginName);

        var document = Assert.Single(scratch.Index.StackOf(DeletedNpc));

        Assert.Null(document.ParseDiagnosis);
        Assert.Contains("\"MajorRecordFlagsRaw\": 32", scratch.Index.BodyOf(DeletedNpc, scratch.Plugin), StringComparison.Ordinal);
    }

    [Fact]
    public void Reconcile_KeepsADeletedRecordThatStillHoldsFieldsItCannotRead_WithItsDiagnosis()
    {
        using var sources = new ScratchDirectory("medit-parsefail-source-");
        using var scratch = new Scratch(Scratch.DeletedNpcPlugin(sources, (path, npc) => DeletedNpcPlugin.WriteHoldingFields(path, npc)), DeletedNpcPluginName);

        var document = Assert.Single(scratch.Index.StackOf(DeletedNpc));

        Assert.NotNull(document.ParseDiagnosis);
    }

    [Fact]
    public void Reconcile_OfAPluginThatCannotBeOpenedAtAllStillReportsAPluginLoadFailure()
    {
        using var scratch = Scratch.Misshaped(corruptWholeFile: true);

        Assert.Contains(scratch.Index.Status.Failures, f => f.Name == MisshapedPerkPlugin.FileName);
    }

    private static IReadOnlyList<RecordSummary> Perks(Scratch scratch) =>
        scratch.Index.Records.GetRecords(["perk"], scratch.Plugin, search: null, limit: 1000, offset: 0).Items;

    private static class CorruptGroupFixture
    {
        internal const string PluginName = "CorruptGroup.esp";

        internal static string BuildWithANpcSignatureMangledSoMutagensLocationScanThrowsBeforeYieldingAnyNpc(ScratchDirectory directory)
        {
            var path = Path.Combine(directory.Path, PluginName);
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("TheNpc");
            mod.Weapons.AddNew("TheWeapon");
            mod.WriteToBinary(path);

            var bytes = File.ReadAllBytes(path);
            var npcSignatureOffsetsTheFirstBeingTheGroupHeadersContainedTypeAndTheSecondTheRecordItself = new List<int>();
            for (var i = 0; i + 4 <= bytes.Length; i++)
            {
                if (bytes[i] == 'N' && bytes[i + 1] == 'P' && bytes[i + 2] == 'C' && bytes[i + 3] == '_')
                    npcSignatureOffsetsTheFirstBeingTheGroupHeadersContainedTypeAndTheSecondTheRecordItself.Add(i);
            }
            bytes[npcSignatureOffsetsTheFirstBeingTheGroupHeadersContainedTypeAndTheSecondTheRecordItself[1]] = (byte)'X';
            File.WriteAllBytes(path, bytes);
            return path;
        }
    }

    private sealed class Scratch : IDisposable
    {
        internal static string DeletedNpcPlugin(ScratchDirectory directory, Action<string, FormKey> write)
        {
            var path = Path.Combine(directory.Path, DeletedNpcPluginName);
            write(path, FormKey.Factory(DeletedNpc));
            return path;
        }

        private readonly ScratchDirectory _gameDirectory = new("medit-parsefail-game-");
        private readonly ScratchDirectory _modFolder = new("medit-parsefail-mod-");

        public OpenedIndex Index { get; }
        public PluginAddress Plugin { get; }
        public string PluginPath { get; }

        internal static Scratch Misshaped(bool corruptWholeFile = false, bool active = true)
        {
            using var sources = new ScratchDirectory("medit-parsefail-source-");
            MisshapedPerkPlugin.Plugin.WriteInto(sources.Path);
            return new Scratch(Path.Combine(sources.Path, MisshapedPerkPlugin.FileName), MisshapedPerkPlugin.FileName, corruptWholeFile, active);
        }

        public Scratch(string sourcePath, string fixtureFileName, bool corruptWholeFile = false, bool active = true)
        {
            Plugin = new PluginAddress(fixtureFileName, Origin);
            var pluginPath = PluginPath = Path.Combine(_modFolder, fixtureFileName);
            File.Copy(sourcePath, pluginPath);

            var inputs = new List<LoadOrderEntry>();
            using (var overlay = Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName(fixtureFileName), pluginPath), Fallout4Release.Fallout4))
            {
                foreach (var master in overlay.ModHeader.MasterReferences)
                {
                    var emptyStubOfADeclaredMasterBecauseTheIndexNeedsTheNamePresentNotTheContent = Path.Combine(_gameDirectory, master.Master.FileName);
                    new Fallout4Mod(master.Master, Fallout4Release.Fallout4).WriteToBinary(emptyStubOfADeclaredMasterBecauseTheIndexNeedsTheNamePresentNotTheContent);
                    inputs.Add(new LoadOrderEntry(master.Master.FileName, emptyStubOfADeclaredMasterBecauseTheIndexNeedsTheNamePresentNotTheContent, "Stubs", inputs.Count, Enabled: true, Winning: true));
                }
            }
            inputs.Add(new LoadOrderEntry(fixtureFileName, pluginPath, Origin, inputs.Count, Enabled: active, Winning: true));

            byte[] truncatedBelowATes4HeaderSoNoRecordIdentityExistsToHangAStatusOn = [0x54, 0x45, 0x53, 0x34, 0xFF];
            if (corruptWholeFile) File.WriteAllBytes(pluginPath, truncatedBelowATes4HeaderSoNoRecordIdentityExistsToHangAStatusOn);

            Index = Indexes.Reconciled(_gameDirectory, inputs);
        }

        public void Dispose()
        {
            Index.Dispose();
            _modFolder.Dispose();
            _gameDirectory.Dispose();
        }
    }
}
