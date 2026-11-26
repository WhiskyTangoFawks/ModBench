using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class ParseFailedRecordTests
{
    private const string Origin = "ParseFailedFixtureMod";
    private static readonly string PerkWhoseEntryPointParameterFlagsMutagenRefuses = MisshapedPerkPlugin.FormKey;
    private const string Diagnosis = "did not have expected parameter type flag";

    [Fact]
    public void AnUnreadableRecord_IsListedAndComparedWithItsDiagnosis_AndTheReadableOnesBesideItCarryNone()
    {
        using var scratch = Scratch.Misshaped();

        var perks = Perks(scratch);
        var readable = perks.Where(r => r.FormKey != PerkWhoseEntryPointParameterFlagsMutagenRefuses).ToList();
        var compared = Assert.Single(scratch.Index.StackOf(PerkWhoseEntryPointParameterFlagsMutagenRefuses));

        Assert.Contains(Diagnosis, perks.Single(r => r.FormKey == PerkWhoseEntryPointParameterFlagsMutagenRefuses).ParseDiagnosis);
        Assert.NotEmpty(readable);
        Assert.All(readable, r => Assert.Null(r.ParseDiagnosis));
        Assert.Equal(MisshapedPerkPlugin.EditorId, compared.EditorId);
        Assert.Contains(Diagnosis, compared.ParseDiagnosis);
        Assert.Null(Assert.Single(scratch.Index.StackOf(readable[0].FormKey)).ParseDiagnosis);
    }

    [Fact]
    public void TheRecordTypeCounts_MarkOnlyTheSubtreeHoldingTheUnreadableRecord()
    {
        const string pluginName = "PerkBesideNpc.esp";
        using var sources = new ScratchDirectory("medit-parsefail-source-");
        var path = Path.Combine(sources.Path, pluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(pluginName), Fallout4Release.Fallout4);
        MisshapedPerks.Add(mod, "Unreadable");
        mod.Npcs.AddNew("Readable");
        mod.WriteToBinary(path);
        MisshapedPerks.Misshape(path);
        using var scratch = new Scratch(path, pluginName);

        var counts = scratch.Index.Queries.GetPluginRecordTypes(scratch.Plugin).Value();

        Assert.True(counts.Single(t => t.Type == "perk").HasParseFailure);
        Assert.False(counts.Single(t => t.Type == "npc_").HasParseFailure);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void OnlyThePluginHoldingTheUnreadableRecord_HasAParseFailure_ActiveOrNot(bool active)
    {
        using var scratch = Scratch.Misshaped(active);

        var plugins = scratch.Index.Queries.GetPlugins().Value();

        Assert.Equal([scratch.Plugin], plugins.Where(p => p.HasParseFailure).Select(p => p.KeyOf()));
        var stubMastersIndexedBesideItSoOnlyHasSomethingToExclude = plugins.Count;
        Assert.True(stubMastersIndexedBesideItSoOnlyHasSomethingToExclude > 1);
    }

    [Fact]
    public void APluginWhoseGroupCannotBeEnumerated_MarksThatRecordTypeAndItsPlugin_AndKeepsItsOtherRecordTypes()
    {
        using var sources = new ScratchDirectory("medit-parsefail-source-");
        using var scratch = new Scratch(CorruptGroupFixture.BuildWithANpcSignatureMangledSoMutagensLocationScanThrowsBeforeYieldingAnyNpc(sources), CorruptGroupFixture.PluginName);

        var counts = scratch.Index.Queries.GetPluginRecordTypes(scratch.Plugin).Value();

        Assert.True(counts.Single(t => t.Type == "npc_").HasParseFailure);
        Assert.False(counts.Single(t => t.Type == "weap").HasParseFailure);
        Assert.Equal(1, counts.Single(t => t.Type == "weap").Count);
        Assert.True(scratch.Index.PluginResponseOf(scratch.Plugin)?.HasParseFailure);
        Assert.DoesNotContain(scratch.Index.Status.Failures, f => f.Name == CorruptGroupFixture.PluginName);
    }

    private static IReadOnlyList<RecordSummary> Perks(Scratch scratch) =>
        scratch.Index.Queries.GetRecords(["perk"], scratch.Plugin, search: null, limit: 1000, offset: 0).Value().Items;

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
        private readonly ScratchDirectory _dataFolder = new("medit-parsefail-data-");
        private readonly ScratchDirectory _modFolder = new("medit-parsefail-mod-");

        public OpenedIndex Index { get; }
        public PluginAddress Plugin { get; }

        internal static Scratch Misshaped(bool active = true)
        {
            using var sources = new ScratchDirectory("medit-parsefail-source-");
            MisshapedPerkPlugin.Plugin.WriteInto(sources.Path);
            return new Scratch(Path.Combine(sources.Path, MisshapedPerkPlugin.FileName), MisshapedPerkPlugin.FileName, active);
        }

        public Scratch(string sourcePath, string fixtureFileName, bool active = true)
        {
            Plugin = new PluginAddress(fixtureFileName, Origin);
            var pluginPath = Path.Combine(_modFolder, fixtureFileName);
            File.Copy(sourcePath, pluginPath);

            var inputs = new List<LoadOrderEntry>();
            using (var overlay = Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName(fixtureFileName), pluginPath), Fallout4Release.Fallout4))
            {
                foreach (var master in overlay.ModHeader.MasterReferences)
                {
                    var emptyStubOfADeclaredMasterBecauseTheIndexNeedsTheNamePresentNotTheContent = Path.Combine(_dataFolder, master.Master.FileName);
                    new Fallout4Mod(master.Master, Fallout4Release.Fallout4).WriteToBinary(emptyStubOfADeclaredMasterBecauseTheIndexNeedsTheNamePresentNotTheContent);
                    inputs.Add(new LoadOrderEntry(master.Master.FileName, emptyStubOfADeclaredMasterBecauseTheIndexNeedsTheNamePresentNotTheContent, "Stubs", inputs.Count, Enabled: true, Winning: true));
                }
            }
            inputs.Add(new LoadOrderEntry(fixtureFileName, pluginPath, Origin, inputs.Count, Enabled: active, Winning: true));

            Index = Indexes.Reconciled(_dataFolder, inputs);
        }

        public void Dispose()
        {
            Index.Dispose();
            _modFolder.Dispose();
            _dataFolder.Dispose();
        }
    }
}
